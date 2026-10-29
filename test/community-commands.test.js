import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { COMMUNITY_COMMANDS, handleCommunityCommand, parseInviteCode } from '../src/community-commands.js';
import { renderEvent, renderWelcome, validateWelcome } from '../src/community-messages.js';
import { CommunityStore } from '../src/community-store.js';
import { CommunityService } from '../src/community.js';

function interaction(commandName, { admin = true, guildId = 'server', values = {} } = {}) {
  const replies = [];
  const i = {
    commandName, guildId, user: { id: 'caller' }, memberPermissions: { has: () => admin },
    isChatInputCommand: () => true, replies,
    options: Object.fromEntries(['getUser', 'getString', 'getChannel', 'getBoolean', 'getSubcommand']
      .map(name => [name, key => values[key] ?? null])),
    async deferReply(options) { i.deferred = options; },
    async editReply(options) { replies.push(options); },
  };
  return i;
}

function fixture(t) {
  const store = new CommunityStore(':memory:', 'server', () => 1800000000000);
  t.after(() => store.close());
  return { guildId: 'server', store, health: 'работает', now: () => 1800000000000,
    tracker: { snapshot: { invites: new Map([['abc', {}]]) } },
    checkChannel: async () => {}, warn: () => {}, testWelcome: async () => {} };
}

test('команды собираются без API и настройки ограничены Manage Guild', () => {
  assert.equal(new Set(COMMUNITY_COMMANDS.map(command => command.name)).size, COMMUNITY_COMMANDS.length);
  assert.equal(COMMUNITY_COMMANDS.find(command => command.name === 'setup').default_member_permissions,
    String(PermissionFlagsBits.ManageGuild));
});

test('проверка прав выполняется и внутри команды; настройки другого сервера не меняются', async t => {
  const service = fixture(t);
  for (const options of [{ admin: false }, { guildId: 'other' }]) {
    const i = interaction('setup', { ...options, values: { welcome_text: 'Новый текст' } });
    await handleCommunityCommand(i, service);
    assert.notEqual(service.store.settings().welcomeTemplate, 'Новый текст');
    assert.ok(i.replies[0].content.includes(options.admin === false ? 'Управлять сервером' : 'настроенном сервере'));
  }
});

test('настройки валидируются целиком до сохранения, неизвестные переменные не принимаются', async t => {
  const service = fixture(t);
  const i = interaction('setup', { values: { welcome_channel: { id: 'channel' }, welcome_text: '{bad}' } });
  await handleCommunityCommand(i, service);
  assert.equal(service.store.settings().welcomeChannelId, undefined);
  assert.match(i.replies[0].content, /Неизвестная переменная/);
});

test('статистика отвечает приватно, упоминания отключены, метка не принимает чужую ссылку', async t => {
  const service = fixture(t);
  const stats = interaction('stats');
  await handleCommunityCommand(stats, service);
  assert.equal(stats.deferred.flags, MessageFlags.Ephemeral);
  assert.deepEqual(stats.replies[0].allowedMentions, { parse: [] });
  const i = interaction('invite-label', { values: { code: 'other', label: 'Метка' } });
  i.options.getSubcommand = () => 'set';
  await handleCommunityCommand(i, service);
  assert.equal(service.store.label('other'), null);
});

test('неизвестные slash-команды не перехватываются', async t => {
  const i = interaction('other');
  assert.equal(await handleCommunityCommand(i, fixture(t)), false);
  assert.equal(i.deferred, undefined);
});

test('шаблоны ограничены по длине, значения не исполняются повторно, разрешены коды и URL', () => {
  assert.throws(() => validateWelcome(''), /1200/);
  assert.throws(() => validateWelcome('x'.repeat(1201)), /1200/);
  const text = renderWelcome('{member} {server} {inviter} {source} {count}',
    { id: '123', guild: { name: '{inviter} @everyone', memberCount: 5 } }, { source: 'unknown' });
  assert.match(text, /<@123>/);
  assert.match(text, /\{inviter\}/);
  assert.match(text, /источник неизвестен/);
  assert.equal(parseInviteCode('https://discord.gg/Ab-c'), 'Ab-c');
  assert.throws(() => parseInviteCode('../token'));
});

test('сообщение журнала не считает молодой аккаунт подделкой', () => {
  const text = renderEvent({ type: 'join', userId: 'user', at: 1800000000000, young: true, source: 'unknown' });
  assert.match(text, /без штрафа/);
  assert.match(text, /неизвестен/);
});

test('при отправке приветствия пингуется только новичок, не роли и не everyone', async t => {
  const store = new CommunityStore(':memory:', 'server');
  t.after(() => store.close());
  const sent = [];
  const channel = { guildId: 'server', type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }),
    send: async options => sent.push(options) };
  const guild = { members: { me: {} }, channels: { fetch: async () => channel } };
  const client = { guilds: { cache: new Map([['server', guild]]) } };
  const service = new CommunityService(client, { guildId: 'server', databasePath: ':memory:' }, { warn() {} }, { store });
  await service.send('channel', '@everyone <@&role> <@owner> <@newcomer>', ['newcomer']);
  assert.deepEqual(sent[0].allowedMentions, { parse: [], users: ['newcomer'], repliedUser: false });
  channel.permissionsFor = () => ({ has: () => false });
  await assert.rejects(service.send('channel', 'test'), /разрешите/);
});
