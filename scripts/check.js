import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 17)) {
  console.error('Для проверок нужен Node.js 24.17 или новее. В WebStorm выберите .runtime/node.exe; инструкция терминала — в README.md.');
  process.exit(1);
}
let failed = false;
for (const directory of ['src', 'scripts', 'test']) {
  for (const file of readdirSync(directory).filter(name => name.endsWith('.js'))) {
    const result = spawnSync(process.execPath, ['--check', join(directory, file)], { stdio: 'inherit' });
    if (result.status !== 0) failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log('Синтаксис JavaScript проверен.');
