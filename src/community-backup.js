import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Копируем средствами SQLite: обычное копирование файла пропустило бы WAL.
export async function backupCommunity(store, databasePath, now = new Date()) {
  const directory = join(dirname(databasePath), 'backups');
  mkdirSync(directory, { recursive: true });
  const name = 'lazybot-' + now.toISOString().slice(0, 10) + '.sqlite';
  const path = join(directory, name);
  await store.backup(path);
  const files = readdirSync(directory).filter(file => /^lazybot-\d{4}-\d{2}-\d{2}\.sqlite$/.test(file)).sort().reverse();
  for (const old of files.slice(7)) unlinkSync(join(directory, old));
  return path;
}
