import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { readConfig, RECONCILE_INTERVAL_MS } from './config.js';
import { createLogger } from './logger.js';
import { createDiscordAdapter } from './discord-adapter.js';
import { RoomManager } from './room-manager.js';

const logger = createLogger();
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);

async function main() {
  if (existsSync('.env')) loadEnvFile('.env');
  let config;
  try { config = readConfig(); }
  catch (error) { logger.warn(error.message); process.exitCode = 1; return; }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    // Не ждём HTTP-запрос бесконечно при потере сети.
    rest: { timeout: 15_000, retries: 2 },
  });
  const manager = new RoomManager(createDiscordAdapter(client, config), logger);
  client.on(Events.ClientReady, () => {
    logger.info('LazyBot подключён. Поддерживаю одну свободную комнату в указанной категории.');
    void manager.resume();
  });
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    if (!client.isReady() || newState.guild.id !== config.guildId || oldState.channelId === newState.channelId) return;
    const relevant = [oldState.channelId, newState.channelId].some(id =>
      id && (manager.emptySince.has(id) || newState.guild.channels.cache.get(id)?.parentId === config.categoryId));
    if (relevant) void manager.voiceChanged(oldState.channelId, newState.channelId);
  });
  for (const event of [Events.ChannelCreate, Events.ChannelDelete, Events.ChannelUpdate]) {
    client.on(event, (channel, updatedChannel) => {
      const updated = updatedChannel ?? channel;
      if (!client.isReady() || updated.guild?.id !== config.guildId) return;
      if ([channel.id, updated.id].includes(config.categoryId)
        || channel.parentId === config.categoryId || updated.parentId === config.categoryId) {
        void manager.request();
      }
    });
  }
  client.on(Events.ShardDisconnect, () => {
    manager.pause();
    logger.warn('Связь с Discord потеряна. Ожидаю переподключения.');
  });
  client.on(Events.ShardResume, () => { if (client.isReady()) void manager.resume(); });
  client.on(Events.ShardReady, () => { if (client.isReady()) void manager.resume(); });
  client.on(Events.GuildAvailable, guild => {
    if (client.isReady() && guild.id === config.guildId) void manager.resume();
  });
  client.on(Events.GuildUnavailable, guild => { if (guild.id === config.guildId) manager.pause(); });
  client.on(Events.Error, () => logger.warn('Ошибка соединения с Discord. Проверьте интернет; бот попробует восстановить связь.'));
  client.on(Events.ShardError, () => logger.warn('Соединение с Discord временно недоступно. Ожидаю восстановления.'));
  client.on(Events.Warn, () => logger.warn('Discord сообщил о временной проблеме соединения.'));

  const interval = setInterval(() => {
    if (!client.isReady()) return;
    if (manager.suspended) void manager.resume();
    else void manager.request();
  }, RECONCILE_INTERVAL_MS);
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    clearInterval(interval);
    manager.stop();
    await client.destroy();
    logger.info('LazyBot остановлен. Голосовые комнаты остаются на сервере.');
  }
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  try {
    await client.login(config.token);
  } catch {
    logger.warn('Не удалось запустить LazyBot. Проверьте токен в .env, интернет и настройки приложения Discord.');
    await shutdown();
    process.exitCode = 1;
  }
}

main().catch(() => {
  logger.warn('Не удалось прочитать настройки или запустить проект. Проверьте файл .env и версию Node.js.');
  process.exitCode = 1;
});
