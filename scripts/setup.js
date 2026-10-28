import { copyFileSync, constants, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
if (existsSync('.env')) {
  console.log('Файл .env уже существует. Ваши настройки сохранены.');
} else {
  copyFileSync('.env.example', '.env', constants.COPYFILE_EXCL);
  console.log('Создан .env. Заполните три значения в WebStorm. Не отправляйте токен в чат или GitHub.');
}
