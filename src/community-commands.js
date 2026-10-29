import { ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder, escapeMarkdown } from 'discord.js';
import { TEMPLATE_VARIABLES, validateWelcome } from './community-messages.js';

const adminPermission = PermissionFlagsBits.ManageGuild;
const textTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
export const COMMUNITY_COMMANDS = [
  new SlashCommandBuilder().setName('setup').setDescription('Настройки приглашений, приветствий и журнала LazyBot')
    .setDefaultMemberPermissions(adminPermission)
    .addChannelOption(option => option.setName('welcome_channel').setDescription('Канал приветствий').addChannelTypes(...textTypes))
    .addChannelOption(option => option.setName('log_channel').setDescription('Закрытый журнал входов и выходов').addChannelTypes(...textTypes))
    .addChannelOption(option => option.setName('leave_channel').setDescription('Канал сообщений о выходе').addChannelTypes(...textTypes))
    .addStringOption(option => option.setName('welcome_text').setDescription('Переменные: {member}, {server}, {inviter}, {source}, {count}').setMaxLength(1200))
    .addBooleanOption(option => option.setName('disable_welcome').setDescription('Отключить приветствия'))
    .addBooleanOption(option => option.setName('disable_leave').setDescription('Отключить сообщения о выходе'))
    .addBooleanOption(option => option.setName('disable_log').setDescription('Отключить журнал')),
  new SlashCommandBuilder().setName('welcome-test').setDescription('Отправить тест приветствия в настроенный канал')
    .setDefaultMemberPermissions(adminPermission),
  new SlashCommandBuilder().setName('invites').setDescription('Приглашённые люди: всего, остались и ушли')
    .addUserOption(option => option.setName('user').setDescription('Участник; по умолчанию вы')),
  new SlashCommandBuilder().setName('inviter').setDescription('Источник последнего записанного входа участника')
    .addUserOption(option => option.setName('user').setDescription('Участник; по умолчанию вы')),
  new SlashCommandBuilder().setName('top').setDescription('Рейтинги LazyBot')
    .addSubcommand(subcommand => subcommand.setName('invites').setDescription('10 участников, пригласивших больше всего людей')
      .addStringOption(periodOption)),
  new SlashCommandBuilder().setName('stats').setDescription('Входы, выходы и источники за выбранный период')
    .addStringOption(periodOption),
  new SlashCommandBuilder().setName('invite-label').setDescription('Метки ссылок: Друзья, YouTube, Партнёры')
    .setDefaultMemberPermissions(adminPermission)
    .addSubcommand(subcommand => subcommand.setName('set').setDescription('Назвать ссылку')
      .addStringOption(option => option.setName('code').setDescription('Код или ссылка Discord').setRequired(true).setMaxLength(150))
      .addStringOption(option => option.setName('label').setDescription('Название источника').setRequired(true).setMaxLength(50)))
    .addSubcommand(subcommand => subcommand.setName('remove').setDescription('Убрать метку')
      .addStringOption(option => option.setName('code').setDescription('Код или ссылка Discord').setRequired(true).setMaxLength(150)))
    .addSubcommand(subcommand => subcommand.setName('list').setDescription('Показать метки')),
].map(command => command.toJSON());

export const COMMUNITY_COMMAND_NAMES = new Set(COMMUNITY_COMMANDS.map(command => command.name));
const adminCommands = new Set(['setup', 'welcome-test', 'invite-label']);

function periodOption(option) {
  return option.setName('period').setDescription('Период: последние 24 часа, 7 или 30 дней, всё время')
    .addChoices(
      { name: 'Всё время', value: 'all' }, { name: '24 часа', value: 'day' },
      { name: '7 дней', value: 'week' }, { name: '30 дней', value: 'month' },
    );
}

function since(interaction, now) {
  const duration = { day: 86400_000, week: 7 * 86400_000, month: 30 * 86400_000 };
  return now - (duration[interaction.options.getString('period')] ?? now);
}

export function parseInviteCode(value) {
  const code = value.trim().replace(/^https?:\/\/(?:www\.)?(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)/i, '').replace(/\/$/, '');
  if (!/^[\w-]{1,64}$/.test(code)) throw new CommunityInputError('Укажите обычный код приглашения или ссылку discord.gg.');
  return code;
}

export class CommunityInputError extends Error {}

export async function handleCommunityCommand(interaction, service) {
  if (!interaction.isChatInputCommand() || !COMMUNITY_COMMAND_NAMES.has(interaction.commandName)) return false;
  const reply = content => interaction.editReply({
    content: content.length > 2000 ? content.slice(0, 1999) + '…' : content,
    allowedMentions: { parse: [] },
  });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (interaction.guildId !== service.guildId) return await reply('Эта команда доступна только на настроенном сервере LazyBot.');
    if (adminCommands.has(interaction.commandName) && !interaction.memberPermissions?.has(adminPermission)) {
      return await reply('Для изменения настроек нужно право «Управлять сервером».');
    }
    const { store } = service;
    const user = interaction.options.getUser('user') ?? interaction.user;
    switch (interaction.commandName) {
      case 'setup': {
        const changes = {};
        for (const [name, key, disable] of [
          ['welcome_channel', 'welcomeChannelId', 'disable_welcome'],
          ['leave_channel', 'leaveChannelId', 'disable_leave'],
          ['log_channel', 'logChannelId', 'disable_log'],
        ]) {
          const channel = interaction.options.getChannel(name);
          if (channel && interaction.options.getBoolean(disable)) throw new CommunityInputError('Нельзя одновременно выбрать и отключить один канал.');
          if (channel) {
            await service.checkChannel(channel);
            changes[key] = channel.id;
          }
          if (interaction.options.getBoolean(disable)) changes[key] = null;
        }
        const template = interaction.options.getString('welcome_text');
        if (template !== null) {
          try { changes.welcomeTemplate = validateWelcome(template); }
          catch (error) { throw new CommunityInputError(error.message); }
        }
        if (Object.keys(changes).length) store.configure(changes);
        const settings = store.settings();
        const channel = key => settings[key] ? '<#' + settings[key] + '>' : 'отключено';
        return await reply([
          'Настройки LazyBot сохранены в базе.',
          'Приветствия: ' + channel('welcomeChannelId'),
          'Сообщения о выходе: ' + channel('leaveChannelId'),
          'Журнал: ' + channel('logChannelId'),
          'Текст: ' + settings.welcomeTemplate,
          'Переменные: ' + TEMPLATE_VARIABLES.map(value => '{' + value + '}').join(', '),
          'Учёт приглашений: ' + service.health,
          'Повторные входы не добавляют приглашения. Возраст аккаунта меньше 7 дней — только отметка.',
          'Сбор данных: с <t:' + Math.floor(store.startedAt / 1000) + ':f>. Старые события не восстанавливаются.',
          'Проверить сообщение: /welcome-test.',
        ].join('\n'));
      }
      case 'welcome-test':
        await service.testWelcome(interaction);
        return await reply('Тестовое приветствие отправлено в настроенный канал.');
      case 'invites': {
        const counts = store.invites(user.id);
        return await reply('<@' + user.id + '> пригласил(а) людей: ' + counts.total
          + '\nСейчас на сервере: ' + counts.present + ' · Ушли: ' + counts.left
          + (counts.unverified ? ' · Ещё проверяются: ' + counts.unverified : '')
          + '\nКаждый человек учитывается один раз, по первому записанному входу. Боты и неизвестные источники не входят в счёт.');
      }
      case 'inviter': {
        const event = store.lastJoin(user.id);
        if (!event) return await reply('Вход этого участника ещё не был записан LazyBot. Старую историю Discord не предоставляет.');
        const inviter = event.inviter_id ? '<@' + event.inviter_id + '>' : 'неизвестно';
        const source = event.label ?? event.invite_code ?? ({ vanity: 'общая ссылка сервера', bot: 'добавление бота' }[event.source] ?? 'неизвестно');
        return await reply('Последний записанный вход <@' + user.id + '>: <t:' + Math.floor(event.at / 1000) + ':f>.'
          + '\nПригласил: ' + inviter + '\nИсточник: ' + escapeMarkdown(source)
          + (event.rejoin ? '\nПовторный вход: новое приглашение не начислено.' : ''));
      }
      case 'top': {
        const rows = store.top(since(interaction, service.now()));
        return await reply(rows.length ? 'Приглашения за выбранный период:\n' + rows.map((row, i) =>
          (i + 1) + '. <@' + row.userId + '> — ' + row.total + ' (сейчас на сервере: ' + row.present + ')').join('\n')
          : 'За выбранный период ещё нет определённых приглашений.');
      }
      case 'stats': {
        const start = since(interaction, service.now());
        const stats = store.stats(start);
        const sources = store.sources(start).map(row => escapeMarkdown(
          ({ unknown: 'Неизвестно', vanity: 'Общая ссылка', bot: 'Боты' }[row.name] ?? row.name)) + ': ' + row.total);
        return await reply([
          'Статистика за выбранный период (без ботов):',
          'Входы: ' + stats.joins + ' · Выходы: ' + stats.leaves + ' · Разница: ' + (stats.joins - stats.leaves),
          'Повторные входы: ' + stats.rejoins + ' · Источник неизвестен: ' + stats.unknown,
          'Входы аккаунтов младше 7 дней: ' + stats.young + ' (без штрафа).',
          sources.length ? 'Источники:\n' + sources.join('\n') : 'Источников пока нет.',
          'Сбор данных: с <t:' + Math.floor(store.startedAt / 1000) + ':f>.',
          'Учитываются наблюдавшиеся события. Во время остановки или потери связи возможны пропуски.',
        ].join('\n'));
      }
      case 'invite-label': {
        const action = interaction.options.getSubcommand();
        if (action === 'list') {
          const rows = store.labels();
          return await reply(rows.length ? rows.slice(0, 20).map(row => escapeMarkdown(row.code + ' — ' + row.label)).join('\n')
            + (rows.length > 20 ? '\nПоказаны первые 20 из ' + rows.length + '.' : '') : 'Метки ещё не заданы.');
        }
        const code = parseInviteCode(interaction.options.getString('code'));
        if (action === 'set') {
          if (!service.tracker.snapshot?.invites.has(code) && service.tracker.snapshot?.vanity?.code !== code) {
            throw new CommunityInputError('Ссылка не найдена среди приглашений этого сервера. Проверьте код, права бота и статус в /setup.');
          }
          const label = interaction.options.getString('label').trim();
          if (!label) throw new CommunityInputError('Название метки не должно быть пустым.');
          store.setLabel(code, label);
        } else store.setLabel(code, null);
        return await reply('Метка сохранена. Изменение применяется к следующим входам; прошлая статистика сохраняет прежние метки.');
      }
    }
  } catch (error) {
    if (error instanceof CommunityInputError) return await reply(error.message);
    service.warn('Команда не выполнена. Проверьте права бота и доступность базы данных; секреты в журнал не выводятся.');
    return await reply('Не удалось выполнить команду. Проверьте права бота и консоль Botkeep. Голосовые комнаты продолжают работать.');
  }
  return true;
}
