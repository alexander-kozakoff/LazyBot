import { ChannelType, PermissionFlagsBits } from 'discord.js';

function configurationError(message) {
  const error = new Error(message);
  error.name = 'ConfigurationError';
  return error;
}

export function createDiscordAdapter(client, { guildId, categoryId }) {
  let guild;
  let visibleRoomIds = new Set();
  function isManaged(channel) {
    return channel?.type === ChannelType.GuildVoice
      && channel.guild.id === guildId
      && channel.parentId === categoryId
      && channel.id !== guild?.afkChannelId;
  }
  function isEmpty(channelId) {
    // VoiceState cache содержит и людей, и ботов; GuildMembers intent не нужен.
    return !guild.voiceStates.cache.some(state => state.channelId === channelId);
  }
  async function checkedCategory() {
    if (!client.isReady()) throw configurationError('Соединение с Discord восстанавливается. Управление каналами приостановлено.');
    guild = client.guilds.cache.get(guildId);
    if (!guild?.available) throw configurationError('Сервер недоступен. Проверьте ID сервера и добавление LazyBot на сервер.');
    const channels = await guild.channels.fetch();
    if (!client.isReady() || !guild.available) throw configurationError('Соединение с Discord восстанавливается. Управление каналами приостановлено.');
    const category = channels.get(categoryId);
    if (category?.type !== ChannelType.GuildCategory) {
      throw configurationError('Категория не найдена. Укажите ID категории «Голосовые комнаты» в DISCORD_CATEGORY_ID.');
    }
    const me = guild.members.me ?? await guild.members.fetchMe();
    if (!client.isReady() || !guild.available) throw configurationError('Соединение с Discord восстанавливается. Управление каналами приостановлено.');
    const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels];
    if (!category.permissionsFor(me)?.has(required)) {
      throw configurationError('Разрешите LazyBot просмотр и управление каналами в категории «Голосовые комнаты».');
    }
    // Без видимости всех комнат нельзя правильно посчитать свободные каналы.
    for (const channel of channels.values()) {
      if (isManaged(channel) && !channel.permissionsFor(me)?.has(required)) {
        throw configurationError('В голосовых комнатах различаются права бота. Синхронизируйте права комнат с категорией.');
      }
    }
    visibleRoomIds = new Set([...channels.values()].filter(isManaged).map(channel => channel.id));
    return { category, channels };
  }
  return {
    async listRooms() {
      const { channels } = await checkedCategory();
      return [...channels.values()].filter(isManaged).map(channel => ({
        id: channel.id,
        name: channel.name,
        members: guild.voiceStates.cache.filter(state => state.channelId === channel.id).size,
      }));
    },
    async createRoom(name) {
      const { category, channels } = await checkedCategory();
      if ([...channels.values()].some(channel => isManaged(channel) && isEmpty(channel.id))) return false;
      // Без индивидуальных overwrites Discord наследует права parent-категории.
      await guild.channels.create({
        name,
        type: ChannelType.GuildVoice,
        parent: category.id,
        reason: 'LazyBot: нужна одна свободная голосовая комната',
      });
      return true;
    },
    isRoomEmpty(channelId) {
      return client.isReady() && guild?.available && visibleRoomIds.has(channelId)
        && isManaged(guild.channels.cache.get(channelId)) && isEmpty(channelId);
    },
    async deleteRoom(channelId) {
      // Повторная синхронная проверка перед непосредственным DELETE.
      if (!this.isRoomEmpty(channelId)) return false;
      const channel = guild.channels.cache.get(channelId);
      await channel.delete('LazyBot: лишняя комната пуста не менее пяти секунд');
      return true;
    },
  };
}
