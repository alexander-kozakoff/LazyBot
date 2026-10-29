import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { CommunityStore } from '../src/community-store.js';
import { backupCommunity } from '../src/community-backup.js';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
if (existsSync('.env')) loadEnvFile('.env');
const path = process.env.COMMUNITY_DATABASE_PATH?.trim() || 'data/lazybot.sqlite';
const guildId = process.env.DISCORD_GUILD_ID?.trim();
let store;
try {
  if (!guildId || !existsSync(path)) throw new Error('Нет существующей базы.');
  store = new CommunityStore(path, guildId);
  const result = await backupCommunity(store, path);
  console.log('Резервная копия SQLite создана: ' + result);
} catch {
  console.error('Не удалось создать копию. Проверьте существующую базу, DISCORD_GUILD_ID и права на папку данных.');
  process.exitCode = 1;
} finally { store?.close(); }
