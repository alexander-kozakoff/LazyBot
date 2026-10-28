import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
import { createLogger, explainError } from '../src/logger.js';

const valid = {
  DISCORD_TOKEN: 'example-test-only',
  DISCORD_GUILD_ID: '123456789012345678',
  DISCORD_CATEGORY_ID: '234567890123456789',
};

test('настройки читаются без потери точности ID', () => {
  assert.equal(readConfig(valid).guildId, valid.DISCORD_GUILD_ID);
});

test('пустой токен и некорректный ID дают понятные сообщения', () => {
  assert.throws(() => readConfig({ ...valid, DISCORD_TOKEN: '' }), /DISCORD_TOKEN/);
  assert.throws(() => readConfig({ ...valid, DISCORD_GUILD_ID: 'сервер' }), /DISCORD_GUILD_ID/);
  assert.throws(() => readConfig({ ...valid, DISCORD_CATEGORY_ID: '' }), /DISCORD_CATEGORY_ID/);
});

test('сообщения об ошибках Discord не содержат исходный секрет', () => {
  for (const code of [10003, 10004, 50001, 50013, 30013, 30030, undefined]) {
    assert.ok(!explainError({ code, message: 'SECRET_TOKEN' }).includes('SECRET_TOKEN'));
  }
});

test('одинаковые предупреждения ограничены одним в минуту', () => {
  let now = 0;
  const messages = [];
  const logger = createLogger({ warn: text => messages.push(text) }, () => now);
  logger.warn('Нет прав');
  logger.warn('Нет прав');
  now = 60_000;
  logger.warn('Нет прав');
  assert.equal(messages.length, 2);
});
