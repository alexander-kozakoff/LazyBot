import { ChannelType, Events, PermissionFlagsBits } from 'discord.js';
import { CommunityStore } from './community-store.js';
import { InviteTracker } from './invite-tracker.js';
import { COMMUNITY_COMMANDS, CommunityInputError, handleCommunityCommand } from './community-commands.js';
import { renderEvent, renderWelcome } from './community-messages.js';
import { backupCommunity } from './community-backup.js';

const sendPermissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages];

export class CommunityService {
  constructor(client, config, logger, { store, now = Date.now } = {}) {
    Object.assign(this, { client, guildId: config.guildId, databasePath: config.databasePath, logger, now });
    this.store = store ?? new CommunityStore(config.databasePath, config.guildId, now);
    this.health = 'ожидаю подключения';
    this.retryAfter = 0;
    this.stopped = false;
    this.notificationQueue = Promise.resolve();
    this.presenceEpoch = 0;
    this.registered = false;
    this.registerRetryAfter = 0;
    this.listeners = [];
    this.tracker = new InviteTracker({
      readSnapshot: () => this.readSnapshot(),
      onJoin: (member, attribution) => this.recordJoin(member, attribution),
      onLeave: (member, at) => this.recordLeave(member, at),
      onError: () => this.warn('Учёт приглашений временно недоступен. Проверьте «Управлять сервером» и подключение. Неопределённые входы не приписываются участникам.'),
    });
  }

  warn(message) { this.logger.warn('Сообщество: ' + message); }
  get guild() { return this.client.guilds.cache.get(this.guildId); }

  install() {
    const listen = (event, action) => {
      const handler = (...args) => {
        if (this.stopped) return;
        Promise.resolve().then(() => action(...args)).catch(() => this.warn('Не удалось обработать событие. Проверьте доступность базы данных и права бота.'));
      };
      this.listeners.push([event, handler]);
      this.client.on(event, handler);
    };
    listen(Events.ClientReady, () => this.resume());
    listen(Events.ShardResume, () => this.resume());
    listen(Events.ShardReady, () => { if (this.client.isReady()) return this.resume(); });
    listen(Events.GuildAvailable, guild => { if (guild.id === this.guildId && this.client.isReady()) return this.resume(); });
    listen(Events.ShardDisconnect, () => this.pause());
    listen(Events.GuildUnavailable, guild => { if (guild.id === this.guildId) this.pause(); });
    listen(Events.GuildMemberAdd, member => {
      if (member.guild.id !== this.guildId) return;
      // Повторные события старых участников не становятся новыми приглашениями.
      if (this.store.member(member.id)?.joined_at === member.joinedTimestamp) return;
      if (member.joinedTimestamp !== null && member.joinedTimestamp < this.store.startedAt) return;
      return this.tracker.join(member);
    });
    listen(Events.GuildMemberRemove, member => {
      if (member.guild.id === this.guildId) return this.tracker.leave(member, this.now());
    });
    listen(Events.InviteCreate, invite => { if (invite.guild?.id === this.guildId) this.tracker.inviteCreated(invite); });
    // DELETE не снимаем с baseline: исчезнувшая одноразовая ссылка делает атрибуцию неоднозначной.
    listen(Events.InteractionCreate, interaction => handleCommunityCommand(interaction, this));
    this.interval = setInterval(() => {
      if (!this.client.isReady() || !this.guild?.available || this.stopped) return;
      if (!this.tracker.snapshot && this.now() >= this.retryAfter) void this.resume();
      else if (!this.registered && this.now() >= this.registerRetryAfter) void this.registerCommands();
    }, 30_000);
    this.interval.unref?.();
    this.backupInterval = setInterval(() => { void this.backup(); }, 24 * 3600_000);
    this.backupInterval.unref?.();
  }

  async readSnapshot() {
    if (this.now() < this.retryAfter) throw new Error('Учёт приглашений ожидает повторной попытки.');
    try {
      const guild = this.guild;
      if (!this.client.isReady() || !guild?.available) throw new Error('Нет соединения.');
      const me = guild.members.me ?? await guild.members.fetchMe();
      if (!me.permissions.has(PermissionFlagsBits.ManageGuild)) throw new Error('Нет доступа к метаданным приглашений.');
      const invites = await guild.invites.fetch({ cache: false });
      const snapshot = { invites: new Map(), vanity: null };
      for (const invite of invites.values()) {
        if (!Number.isSafeInteger(invite.uses) || invite.uses < 0) throw new Error('Нет счётчиков приглашений.');
        snapshot.invites.set(invite.code, { uses: invite.uses, inviterId: invite.inviter?.id ?? null });
      }
      if (guild.features.includes('VANITY_URL')) {
        const vanity = await guild.fetchVanityData();
        if (vanity.code) {
          if (!Number.isSafeInteger(vanity.uses)) throw new Error('Нет счётчика общей ссылки.');
          snapshot.vanity = { code: vanity.code, uses: vanity.uses };
        }
      }
      if (!this.client.isReady() || !guild.available || this.stopped) throw new Error('Соединение прервано.');
      this.health = 'работает';
      return snapshot;
    } catch {
      this.health = 'недоступен — проверьте подключение и право «Управлять сервером»';
      this.retryAfter = this.now() + 30_000;
      throw new Error('Не удалось получить счётчики приглашений.');
    }
  }

  resume() {
    if (this.stopped || this.resuming || !this.client.isReady() || !this.guild?.available) return this.resuming;
    this.resuming = (async () => {
      await this.tracker.resume();
      if (this.stopped) return;
      void this.registerCommands();
      void this.backup();
      if (!this.checkingPresence) {
        this.checkingPresence = this.reconcilePresence().catch(() => this.warn('Проверка присутствия не завершена; непроверенные участники отмечены отдельно.'))
          .finally(() => { this.checkingPresence = null; });
      }
    })().finally(() => { this.resuming = null; });
    return this.resuming;
  }

  pause() {
    this.health = 'соединение восстанавливается';
    this.presenceEpoch += 1;
    this.tracker.pause();
  }

  async reconcilePresence() {
    const epoch = this.presenceEpoch;
    const members = this.store.markPresenceUnknown();
    for (const row of members) {
      if (this.stopped || epoch !== this.presenceEpoch || !this.client.isReady() || !this.guild?.available) return;
      try {
        const member = await this.guild.members.fetch({ user: row.user_id, force: true, cache: false });
        if (this.stopped || epoch !== this.presenceEpoch || !this.client.isReady()) return;
        this.store.reconcilePresence(row.user_id, member.joinedTimestamp, true, row.updated_at);
      } catch (error) {
        if (this.stopped || epoch !== this.presenceEpoch) return;
        if (Number(error?.code) === 10007) this.store.reconcilePresence(row.user_id, null, false, row.updated_at);
        else { this.warn('Не удалось проверить присутствие участника. В /invites он отмечен как непроверенный.'); return; }
      }
    }
  }

  async registerCommands() {
    if (this.registered || this.registering || this.stopped || this.now() < this.registerRetryAfter) return;
    this.registering = true;
    try {
      // Upsert по имени не удаляет другие команды приложения.
      for (const command of COMMUNITY_COMMANDS) {
        if (this.stopped || !this.client.isReady()) return;
        await this.guild.commands.create(command);
      }
      this.registered = true;
      this.logger.info('Команды приглашений и приветствий зарегистрированы на выбранном сервере.');
    } catch {
      this.registerRetryAfter = this.now() + 60_000;
      this.warn('Не удалось зарегистрировать команды. Проверьте установку LazyBot с поддержкой команд приложений.');
    } finally { this.registering = false; }
  }

  recordJoin(member, attribution) {
    const event = this.store.join({
      userId: member.id, joinedAt: member.joinedTimestamp ?? this.now(),
      createdAt: member.user.createdTimestamp, bot: member.user.bot, attribution,
    });
    if (!event) return;
    const settings = this.store.settings();
    if (!event.bot && settings.welcomeChannelId) {
      this.notify(settings.welcomeChannelId, renderWelcome(settings.welcomeTemplate, member, event), [member.id]);
    }
    if (settings.logChannelId) this.notify(settings.logChannelId, renderEvent(event));
  }

  recordLeave(member, at) {
    const event = this.store.leave(member.id, member.user.bot, at);
    if (!event) return;
    const settings = this.store.settings();
    if (!event.bot && settings.leaveChannelId && settings.leaveChannelId !== settings.logChannelId) {
      this.notify(settings.leaveChannelId, 'Участник <@' + member.id + '> покинул сервер.');
    }
    if (settings.logChannelId) this.notify(settings.logChannelId, renderEvent(event));
  }

  async checkChannel(channel) {
    if (channel.guildId !== this.guildId || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
      throw new CommunityInputError('Выберите текстовый канал этого сервера.');
    }
    const me = this.guild.members.me ?? await this.guild.members.fetchMe();
    if (!channel.permissionsFor(me)?.has(sendPermissions)) {
      throw new CommunityInputError('В выбранном канале разрешите LazyBot «Просматривать канал» и «Отправлять сообщения».');
    }
  }

  async send(channelId, content, users = []) {
    const channel = await this.guild.channels.fetch(channelId);
    if (!channel) throw new CommunityInputError('Настроенный канал удалён. Выберите новый через /setup.');
    await this.checkChannel(channel);
    await channel.send({ content, allowedMentions: { parse: [], users, repliedUser: false } });
  }

  notify(channelId, content, users = []) {
    this.notificationQueue = this.notificationQueue.then(async () => {
      if (!this.stopped) await this.send(channelId, content, users);
    }).catch(() => this.warn('Сообщение не отправлено. Проверьте настроенные каналы в /setup и разрешения на просмотр и отправку. Событие сохранено в базе.'));
  }

  async testWelcome(interaction) {
    const settings = this.store.settings();
    if (!settings.welcomeChannelId) throw new CommunityInputError('Сначала выберите welcome_channel в /setup.');
    const member = { id: interaction.user.id, guild: this.guild };
    const event = { source: 'invite', inviterId: interaction.user.id, code: 'test', label: 'Проверка' };
    await this.send(settings.welcomeChannelId, renderWelcome(settings.welcomeTemplate, member, event), [interaction.user.id]);
  }

  async backup() {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (this.stopped || this.backingUp || this.databasePath === ':memory:' || this.lastBackupDate === today) return;
    this.backingUp = backupCommunity(this.store, this.databasePath, new Date(this.now()))
      .then(() => { this.lastBackupDate = today; })
      .catch(() => this.warn('Резервная копия базы не создана. Проверьте свободное место и права на папку data.'))
      .finally(() => { this.backingUp = null; });
    await this.backingUp;
  }

  async stop() {
    this.stopped = true;
    this.presenceEpoch += 1;
    clearInterval(this.interval);
    clearInterval(this.backupInterval);
    for (const [event, handler] of this.listeners) this.client.off(event, handler);
    await this.tracker.stop();
    await Promise.allSettled([this.resuming, this.checkingPresence, this.backingUp, this.notificationQueue]);
    this.store.close();
  }
}
