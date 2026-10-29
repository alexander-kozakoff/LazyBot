export const EMPTY_DELAY_MS = 5_000;
export const RECONCILE_INTERVAL_MS = 30_000;
export const ROOM_PREFIX = 'Комната';

export function readConfig(env = process.env) {
  const token = env.DISCORD_TOKEN?.trim();
  if (!token || /^(your|insert|paste|replace|<)/i.test(token)) {
    throw new Error('Укажите секретный ключ в DISCORD_TOKEN внутри файла .env. Не отправляйте его в чат.');
  }
  for (const key of ['DISCORD_GUILD_ID', 'DISCORD_CATEGORY_ID']) {
    if (!/^\d{17,20}$/.test(env[key]?.trim() ?? '')) {
      throw new Error(`Заполните ${key} в файле .env: нужен числовой ID из Discord.`);
    }
  }
  const communityEnabled = env.COMMUNITY_ENABLED?.trim().toLowerCase() || 'false';
  if (!['true', 'false'].includes(communityEnabled)) {
    throw new Error('COMMUNITY_ENABLED должен быть true или false.');
  }
  return {
    token,
    guildId: env.DISCORD_GUILD_ID.trim(),
    categoryId: env.DISCORD_CATEGORY_ID.trim(),
    communityEnabled: communityEnabled === 'true',
    databasePath: env.COMMUNITY_DATABASE_PATH?.trim() || 'data/lazybot.sqlite',
  };
}
