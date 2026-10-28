import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType, Collection, PermissionFlagsBits } from 'discord.js';
import { createDiscordAdapter } from '../src/discord-adapter.js';

function fixture() {
  const guildId = '123456789012345678';
  const categoryId = '234567890123456789';
  const created = [];
  const deleted = [];
  const cache = new Collection();
  const states = new Collection();
  const guild = {
    id: guildId, available: true, afkChannelId: 'afk',
    voiceStates: { cache: states }, members: { me: { id: 'bot' } },
    channels: {
      cache,
      async fetch() { return cache.clone(); },
      async create(options) { created.push(options); },
    },
  };
  const client = { isReady: () => true, guilds: { cache: new Collection([[guildId, guild]]) } };
  function add(id, type = ChannelType.GuildVoice, parentId = categoryId) {
    const channel = {
      id, name: `Комната ${id}`, guild, type, parentId,
      permissionsFor: () => ({ has: () => true }),
      async delete() { deleted.push(id); cache.delete(id); },
    };
    cache.set(id, channel);
    return channel;
  }
  add(categoryId, ChannelType.GuildCategory, null);
  const adapter = createDiscordAdapter(client, { guildId, categoryId });
  return { adapter, add, cache, states, client, guild, created, deleted, categoryId };
}

test('обрабатываются только голосовые комнаты нужной категории; AFK, сцены и текст исключены', async () => {
  const f = fixture();
  f.add('voice');
  f.add('afk');
  f.add('outside', ChannelType.GuildVoice, 'other-category');
  f.add('stage', ChannelType.GuildStageVoice);
  f.add('text', ChannelType.GuildText);
  assert.deepEqual((await f.adapter.listRooms()).map(room => room.id), ['voice']);
});

test('подсчёт учитывает все голосовые состояния, включая ботов, без списка участников сервера', async () => {
  const f = fixture();
  f.add('voice');
  f.states.set('human', { channelId: 'voice' });
  f.states.set('music-bot', { channelId: 'voice' });
  assert.equal((await f.adapter.listRooms())[0].members, 2);
  assert.equal(f.adapter.isRoomEmpty('voice'), false);
});

test('создание указывает parent, права наследуются без индивидуальных overwrites', async () => {
  const f = fixture();
  await f.adapter.createRoom('Комната 1');
  assert.equal(f.created[0].parent, f.categoryId);
  assert.equal(f.created[0].type, ChannelType.GuildVoice);
  assert.equal('permissionOverwrites' in f.created[0], false);
});

test('если пустую комнату успели создать вручную, вторая не создаётся', async () => {
  const f = fixture();
  f.add('voice');
  assert.equal(await f.adapter.createRoom('Комната 1'), false);
  assert.equal(f.created.length, 0);
});

test('категория отсутствует или нет прав: операции останавливаются', async () => {
  const f = fixture();
  const category = f.cache.get(f.categoryId);
  category.permissionsFor = () => ({ has: () => false });
  await assert.rejects(f.adapter.listRooms(), /Разрешите/);
  f.cache.delete(f.categoryId);
  await assert.rejects(f.adapter.listRooms(), /Категория не найдена/);
  assert.deepEqual(f.created, []);
  assert.deepEqual(f.deleted, []);
});

test('рассинхронизированные права комнат обнаруживаются до удаления', async () => {
  const f = fixture();
  f.add('voice').permissionsFor = () => ({ has: () => false });
  await assert.rejects(f.adapter.listRooms(), /Синхронизируйте/);
});

function denyConnect(channel) {
  channel.permissionsFor = () => ({
    has: permissions => !(Array.isArray(permissions) ? permissions : [permissions])
      .includes(PermissionFlagsBits.Connect),
  });
}

test('запрет Connect в приватной категории обнаруживается при наличии ViewChannel и ManageChannels', async () => {
  const f = fixture();
  denyConnect(f.cache.get(f.categoryId));
  await assert.rejects(f.adapter.listRooms(), /Подключаться/);
  await assert.rejects(f.adapter.createRoom('Комната 1'), /Подключаться/);
  assert.deepEqual(f.created, []);
});

test('запрет Connect в отдельной комнате останавливает управление до синхронизации прав', async () => {
  const f = fixture();
  denyConnect(f.add('private'));
  await assert.rejects(f.adapter.listRooms(), /Подключаться/);
  assert.deepEqual(f.deleted, []);
});

test('если Connect запретили после сверки, DELETE не отправляется', async () => {
  const f = fixture();
  const channel = f.add('private');
  await f.adapter.listRooms();
  denyConnect(channel);
  assert.equal(await f.adapter.deleteRoom('private'), false);
  assert.deepEqual(f.deleted, []);
});

test('адаптер не удаляет занятые, перенесённые и посторонние каналы', async () => {
  const f = fixture();
  f.add('occupied');
  f.add('moved');
  f.add('outside', ChannelType.GuildVoice, 'other-category');
  await f.adapter.listRooms();
  f.states.set('human', { channelId: 'occupied' });
  f.cache.get('moved').parentId = 'other-category';
  for (const id of ['occupied', 'moved', 'outside', 'missing']) {
    assert.equal(await f.adapter.deleteRoom(id), false);
  }
  assert.deepEqual(f.deleted, []);
});

test('при потере соединения удаления прекращаются', async () => {
  const f = fixture();
  f.add('voice');
  await f.adapter.listRooms();
  f.client.isReady = () => false;
  assert.equal(await f.adapter.deleteRoom('voice'), false);
  await assert.rejects(f.adapter.listRooms(), /Соединение/);
});

test('потеря соединения во время полной сверки останавливает проверку', async () => {
  const f = fixture();
  f.guild.channels.fetch = async () => {
    f.client.isReady = () => false;
    return f.cache.clone();
  };
  await assert.rejects(
    f.adapter.listRooms({ refresh: true }),
    /Соединение/
  );assert.deepEqual(f.created, []);
});

test('отсутствующие в HTTP-ответе каналы не берутся из старого кэша', async () => {
  const f = fixture();
  f.add('stale');
  f.guild.channels.fetch = async () => new Collection([[f.categoryId, f.cache.get(f.categoryId)]]);
  assert.deepEqual(await f.adapter.listRooms({ refresh: true }), []);
  assert.equal(await f.adapter.deleteRoom('stale'), false);
});
test('постоянная комната сохраняется и не мешает созданию свободной', async () => {
  const f = fixture();
  f.guild.members.me.roles = { botRole: { id: 'bot-role' } };

  const permanent = f.add('permanent');
  await f.adapter.listRooms();

  permanent.permissionOverwrites = {
    cache: new Collection([
      ['bot-role', {
        deny: {
          has: permission => permission === PermissionFlagsBits.ManageChannels,
        },
      }],
    ]),
  };

  permanent.permissionsFor = () => ({ has: () => false });

  assert.equal(await f.adapter.deleteRoom(permanent.id), false);
  assert.deepEqual(await f.adapter.listRooms(), []);

  await f.adapter.createRoom('Комната 1');
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.deleted, []);
});
