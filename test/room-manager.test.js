import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager, nextRoomName } from '../src/room-manager.js';

const room = (number, members = 0) => ({ id: String(number), name: `Комната ${number}`, members });

function fixture(initial = []) {
  let time = 0;
  let timerId = 0;
  const timers = new Map();
  const rooms = initial.map(value => ({ ...value }));
  const operations = [];
  const warnings = [];
  const adapter = {
    async listRooms() { return rooms.map(value => ({ ...value })); },
    async createRoom(name) {
      operations.push(['create', name]);
      rooms.push({ id: `new-${operations.length}`, name, members: 0 });
    },
    isRoomEmpty(id) { return rooms.some(value => value.id === id && value.members === 0); },
    async deleteRoom(id) {
      operations.push(['delete', id]);
      rooms.splice(rooms.findIndex(value => value.id === id), 1);
    },
  };
  const manager = new RoomManager(adapter, { info() {}, warn(message) { warnings.push(message); } }, {
    now: () => time,
    setTimer(fn, delay) { const id = ++timerId; timers.set(id, { fn, due: time + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
  });
  async function tick(ms) {
    const target = time + ms;
    for (let guard = 0; guard < 100; guard++) {
      const next = [...timers.entries()].sort((a, b) => a[1].due - b[1].due)[0];
      if (!next || next[1].due > target) { time = target; return; }
      time = next[1].due;
      timers.delete(next[0]);
      next[1].fn();
      await manager.running;
    }
    throw new Error('Таймеры зациклились');
  }
  return { rooms, operations, warnings, adapter, manager, tick, timers };
}

test('при первом запуске в пустой категории создаётся Комната 1', async () => {
  const f = fixture();
  await f.manager.request();
  assert.deepEqual(f.operations, [['create', 'Комната 1']]);
});

test('если одна комната свободна, ничего не меняется', async () => {
  const f = fixture([room(1, 2), room(2)]);
  await f.manager.request();
  await f.tick(30_000);
  assert.deepEqual(f.operations, []);
});

test('заняты все комнаты, включая комнату с ботом: создаётся свободная', async () => {
  const f = fixture([room(1, 1), room(2, 3)]);
  await f.manager.request();
  assert.deepEqual(f.operations, [['create', 'Комната 3']]);
});

test('лишние пустые комнаты удаляются через 5 секунд, сохраняется наименьший номер', async () => {
  const f = fixture([room(10), room(2), room(1, 2)]);
  await f.manager.request();
  await f.tick(4_999);
  assert.deepEqual(f.operations, []);
  await f.tick(1);
  assert.deepEqual(f.operations, [['delete', '10']]);
  assert.deepEqual(f.rooms.map(value => value.id), ['2', '1']);
});

test('несколько лишних пустых каналов удаляются, занятый остаётся', async () => {
  const f = fixture([room(4), room(3, 1), room(2), room(1)]);
  await f.manager.request();
  await f.tick(5_000);
  assert.deepEqual(f.operations, [['delete', '2'], ['delete', '4']]);
  assert.deepEqual(f.rooms.map(value => value.id), ['3', '1']);
});

test('возвращение участника отменяет удаление', async () => {
  const f = fixture([room(1), room(2)]);
  await f.manager.request();
  await f.tick(4_000);
  f.rooms[1].members = 1;
  await f.manager.voiceChanged(null, '2');
  await f.tick(2_000);
  assert.deepEqual(f.operations, []);
});

test('быстрый вход и выход запускают новые пять секунд пустоты', async () => {
  const f = fixture([room(1), room(2)]);
  await f.manager.request();
  await f.tick(4_000);
  f.rooms[1].members = 1;
  const first = f.manager.voiceChanged(null, '2');
  f.rooms[1].members = 0;
  const second = f.manager.voiceChanged('2', null);
  await Promise.all([first, second]);
  await f.tick(4_999);
  assert.deepEqual(f.operations, []);
  await f.tick(1);
  assert.deepEqual(f.operations, [['delete', '2']]);
});

test('переход: старый канал освобождается, новый становится занятым', async () => {
  const f = fixture([room(1, 1), room(2)]);
  await f.manager.request();
  f.rooms[0].members = 0;
  f.rooms[1].members = 1;
  await f.manager.voiceChanged('1', '2');
  await f.tick(5_000);
  assert.deepEqual(f.operations, []);
});

test('одновременные запросы не создают несколько свободных комнат', async () => {
  const f = fixture([room(1, 1)]);
  await Promise.all(Array.from({ length: 40 }, () => f.manager.request()));
  assert.deepEqual(f.operations, [['create', 'Комната 2']]);
});

test('перед удалением повторно проверяется актуальная занятость', async () => {
  const f = fixture([room(1), room(2)]);
  await f.manager.request();
  f.adapter.isRoomEmpty = id => {
    f.rooms.find(value => value.id === id).members = 1;
    return false;
  };
  await f.tick(5_000);
  assert.deepEqual(f.operations, []);
});

test('после перезапуска лишним комнатам предоставляются новые пять секунд', async () => {
  const f = fixture([room(1), room(2)]);
  await f.manager.request();
  assert.deepEqual(f.operations, []);
  await f.tick(5_000);
  assert.deepEqual(f.operations, [['delete', '2']]);
});

test('после потери связи старое время пустоты не используется', async () => {
  const f = fixture([room(1), room(2)]);
  await f.manager.request();
  await f.tick(4_000);
  f.manager.pause();
  await f.manager.request();
  await f.tick(4_999);
  assert.deepEqual(f.operations, []);
  await f.tick(1);
  assert.deepEqual(f.operations, [['delete', '2']]);
});

test('ошибки прав не повторяются чаще 30 секунд, затем бот восстанавливается', async () => {
  const f = fixture();
  const original = f.adapter.listRooms;
  let calls = 0;
  f.adapter.listRooms = async () => { calls++; throw Object.assign(new Error('secret'), { code: 50013 }); };
  await f.manager.request();
  await Promise.all(Array.from({ length: 10 }, () => f.manager.request()));
  await f.tick(29_999);
  assert.equal(calls, 1);
  assert.equal(f.warnings.length, 1);
  assert.ok(!f.warnings[0].includes('secret'));
  f.adapter.listRooms = original;
  await f.tick(1);
  assert.deepEqual(f.operations, [['create', 'Комната 1']]);
});

test('ошибка создания из-за лимита не вызывает бесконечных повторов', async () => {
  const f = fixture();
  let attempts = 0;
  f.adapter.createRoom = async () => { attempts++; throw Object.assign(new Error(), { code: 30013 }); };
  await f.manager.request();
  await f.manager.request();
  await f.tick(29_999);
  assert.equal(attempts, 1);
  assert.match(f.warnings[0], /лимит/);
});

test('удаление комнаты администратором учитывается следующей сверкой', async () => {
  const f = fixture([room(1, 1), room(2)]);
  await f.manager.request();
  f.rooms.pop();
  await f.manager.request();
  assert.deepEqual(f.operations, [['create', 'Комната 2']]);
});

test('остановка отменяет таймер удаления', async () => {
  const f = fixture([room(1), room(2)]);
  await f.manager.request();
  f.manager.stop();
  await f.tick(30_000);
  await f.manager.request();
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.operations, []);
});

test('остановка во время чтения каналов не создаёт комнату', async () => {
  const f = fixture();
  let resolve;
  f.adapter.listRooms = () => new Promise(done => { resolve = done; });
  const pending = f.manager.request();
  f.manager.stop();
  resolve([]);
  await pending;
  assert.deepEqual(f.operations, []);
});

test('номер новой комнаты — минимальный свободный, чужие названия сохраняются', () => {
  assert.equal(nextRoomName([room(1), room(3), { name: 'Разговор' }]), 'Комната 2');
});
