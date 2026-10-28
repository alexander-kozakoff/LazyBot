import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
let failed = false;
for (const directory of ['src', 'scripts', 'test']) {
  for (const file of readdirSync(directory).filter(name => name.endsWith('.js'))) {
    const result = spawnSync(process.execPath, ['--check', join(directory, file)], { stdio: 'inherit' });
    if (result.status !== 0) failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log('Синтаксис JavaScript проверен.');
