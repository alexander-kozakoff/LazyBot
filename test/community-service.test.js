import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChannelType, Collection, Events, PermissionFlagsBits } from 'discord.js';
import { CommunityService } from '../src/community.js';
import { CommunityStore } from '../src/community-store.js';

const guildId = '1111667504276836523';
const now = 1800000000000;
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
  const store = new CommunityStore(':memory:', guildId, () => now - 10000);
  const warnings = [];
  const sent = [];
  const registered = [];
  const client = new EventEmitter();
  client.isReady = () => true;
  let uses = 0;
  let permitted = true;
  let sendFailure = false;
  const text = {
    id: 'text', guildId, type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => permitted }),
    async send(options) { if (sendFailure) throw new Error('SECRET_TOKEN'); sent.push(options); },
  };
  const guild = {
    id: guildId, available: true, name: 'Lazy Dice', memberCount: 10, features: [],
    members: {
      me: { permissions: { has: bit => permitted && bit === PermissionFlagsBits.ManageGuild } },
      async fetch() { const error = new Error('unknown'); error.code = 10007; throw error; },
    },
    invites: { async fetch() { return new Collection([['friends', { code: 'friends', uses, inviter: { id: 'owner' } }]]); } },
    channels: { async fetch() { return text; } },
    commands: { async create(command) { registered.push(command.name); } },
  };
  client.guilds = { cache: new Collection([[guildId, guild]]) };
  const service = new CommunityService(client, { guildId, databasePath: ':memory:' },
    { info() {}, warn(message) { warnings.push(message); } }, { store, now: () => now });
  service.tracker.setTimer = () => 1;
  service.tracker.clearTimer = () => {};
  service.install();
  t.after(() => service.stop());
  await service.resume();
  await tick();
  const member = (id = 'new', at = now) => ({
    id, guild, joinedTimestamp: at, user: { id, createdTimestamp: now - 30 * 86400_000, bot: false },
  });
  async function flush() { await tick(); await service.tracker.flush(); await tick(); await service.notificationQueue; }
  return { service, store, member, guild, client, warnings, sent, registered, flush,
    increment() { uses += 1; }, permit(value) { permitted = value; }, failSend(value) { sendFailure = value; } };
}

test('события Discord проходят до SQLite и приветствия; чужой сервер и повторный Gateway исключены', async t => {
  const f = await fixture(t);
  f.store.configure({ welcomeChannelId: 'text', logChannelId: 'text' });
  f.increment();
  f.client.emit(Events.GuildMemberAdd, f.member());
  await f.flush();
  assert.equal(f.store.invites('owner').total, 1);
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent[0].allowedMentions.users, ['new']);
  f.client.emit(Events.GuildMemberAdd, f.member());
  f.client.emit(Events.GuildMemberAdd, { ...f.member('foreign'), guild: { id: 'other' } });
  await f.flush();
  assert.equal(f.store.stats().joins, 1);
  f.client.emit(Events.GuildMemberRemove, f.member());
  await f.flush();
  assert.equal(f.store.invites('owner').left, 1);
  assert.ok(f.registered.includes('setup'));
});

test('ошибка отправки не теряет событие и не раскрывает исходную ошибку Discord', async t => {
  const f = await fixture(t);
  f.store.configure({ welcomeChannelId: 'text' });
  f.failSend(true);
  f.increment();
  f.client.emit(Events.GuildMemberAdd, f.member());
  await f.flush();
  assert.equal(f.store.stats().joins, 1);
  assert.ok(f.warnings.some(message => message.includes('Сообщение не отправлено')));
  assert.ok(f.warnings.every(message => !message.includes('SECRET_TOKEN')));
});

test('отсутствие Manage Guild оставляет вход неизвестным и допускает приветствие без атрибуции', async t => {
  const f = await fixture(t);
  f.permit(false);
  f.increment();
  f.client.emit(Events.GuildMemberAdd, f.member());
  await f.flush();
  assert.equal(f.store.stats().unknown, 1);
  assert.equal(f.store.invites('owner').total, 0);
  assert.match(f.service.health, /недоступен/);
});

test('выход во время паузы записывается; восстановление не придумывает события за простой', async t => {
  const f = await fixture(t);
  f.increment();
  f.client.emit(Events.GuildMemberAdd, f.member());
  await f.flush();
  f.service.pause();
  f.client.emit(Events.GuildMemberRemove, f.member());
  await f.flush();
  assert.equal(f.store.stats().leaves, 1);
  await f.service.resume();
  assert.equal(f.store.stats().leaves, 1);
});

test('проверка присутствия после перезапуска учитывает покинувших сервер без выдуманного времени ухода', async t => {
  const f = await fixture(t);
  f.increment();
  f.client.emit(Events.GuildMemberAdd, f.member());
  await f.flush();
  await f.service.reconcilePresence();
  assert.equal(f.store.invites('owner').left, 1);
  assert.equal(f.store.stats().leaves, 0);
});
