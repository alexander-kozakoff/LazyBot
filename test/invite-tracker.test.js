import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeJoins, InviteTracker } from '../src/invite-tracker.js';

function snapshot(entries = [['one', 0, 'owner']], vanity = null) {
  return { invites: new Map(entries.map(([code, uses, inviterId]) => [code, { uses, inviterId }])), vanity };
}
const member = (id, bot = false) => ({ id, joinedTimestamp: 1000, user: { bot } });

test('ссылка определяется только при однозначном совпадении счётчиков и количества входов', () => {
  assert.deepEqual(attributeJoins(snapshot(), snapshot([['one', 1, 'owner']]), 1),
    { source: 'invite', code: 'one', inviterId: 'owner' });
  assert.equal(attributeJoins(snapshot(), snapshot([['one', 2, 'owner']]), 1).source, 'unknown');
  assert.equal(attributeJoins(snapshot(), snapshot([['one', 2, 'owner']]), 2).source, 'invite');
  assert.equal(attributeJoins(null, snapshot(), 1).source, 'unknown');
});

test('одновременные разные ссылки, новая использованная ссылка и удалённая одноразовая ссылка остаются неизвестными', () => {
  const two = snapshot([['one', 0, 'a'], ['two', 0, 'b']]);
  assert.equal(attributeJoins(two, snapshot([['one', 1, 'a'], ['two', 1, 'b']]), 2).source, 'unknown');
  assert.equal(attributeJoins(snapshot(), snapshot([['one', 0, 'a'], ['new', 1, 'b']]), 1).source, 'unknown');
  assert.equal(attributeJoins(snapshot(), snapshot([]), 1).source, 'unknown');
  assert.equal(attributeJoins(snapshot([['one', 2, 'a']]), snapshot([['one', 1, 'a']]), 1).source, 'unknown');
});

test('общая ссылка сервера определяется отдельно и не присваивает приглашение участнику', () => {
  assert.deepEqual(attributeJoins(snapshot([], { code: 'public', uses: 3 }), snapshot([], { code: 'public', uses: 4 }), 1),
    { source: 'vanity', code: 'public', inviterId: null });
});

function fixture() {
  let next = snapshot();
  let reads = 0;
  let fail = false;
  const events = [];
  const warnings = [];
  const tracker = new InviteTracker({
    readSnapshot: async () => { reads += 1; if (fail) throw new Error('SECRET'); return next; },
    onJoin: (m, attribution) => events.push({ id: m.id, ...attribution }),
    onLeave: m => events.push({ id: m.id, leave: true }),
    onError: () => warnings.push('Ошибка'),
    setTimer: () => 1, clearTimer: () => {},
  });
  return {
    tracker, events, warnings, reads: () => reads,
    next: value => { next = value; }, fail: value => { fail = value; },
  };
}

test('пачка входов использует один запрос, сохраняет выходы в порядке событий и не считает ботов', async () => {
  const f = fixture();
  await f.tracker.resume();
  f.next(snapshot([['one', 2, 'owner']]));
  const pending = [f.tracker.join(member('a')), f.tracker.leave(member('a'), 2), f.tracker.join(member('b')), f.tracker.join(member('bot', true))];
  await f.tracker.flush();
  await Promise.all(pending);
  assert.equal(f.reads(), 2);
  assert.deepEqual(f.events.map(event => event.id), ['a', 'a', 'b', 'bot']);
  assert.equal(f.events[0].inviterId, 'owner');
  assert.equal(f.events[1].leave, true);
});

test('потеря доступа сбрасывает baseline: восстановление не начисляет пропущенные входы', async () => {
  const f = fixture();
  await f.tracker.resume();
  f.fail(true);
  let pending = f.tracker.join(member('a'));
  await f.tracker.flush(); await pending;
  f.fail(false);
  f.next(snapshot([['one', 10, 'owner']]));
  pending = f.tracker.join(member('b'));
  await f.tracker.flush(); await pending;
  f.next(snapshot([['one', 11, 'owner']]));
  pending = f.tracker.join(member('c'));
  await f.tracker.flush(); await pending;
  assert.deepEqual(f.events.map(event => event.source), ['unknown', 'unknown', 'invite']);
  assert.equal(f.warnings.length, 1);
});

test('разрыв связи во время HTTP не использует устаревший снимок', async () => {
  let resolveRead;
  const f = fixture();
  await f.tracker.resume();
  f.tracker.readSnapshot = () => new Promise(resolve => { resolveRead = resolve; });
  const pending = f.tracker.join(member('a'));
  const running = f.tracker.flush();
  f.tracker.pause();
  resolveRead(snapshot([['one', 1, 'owner']]));
  await running; await pending;
  assert.equal(f.events[0].source, 'unknown');
  assert.equal(f.tracker.snapshot, null);
});

test('остановка сохраняет ожидающие события без HTTP, новые события больше не принимаются', async () => {
  const f = fixture();
  await f.tracker.resume();
  const pending = f.tracker.join(member('a'));
  await f.tracker.stop(); await pending;
  await f.tracker.join(member('b'));
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].source, 'unknown');
  assert.equal(f.reads(), 1);
});

test('InviteCreate с нулевым счётчиком позволяет распознать новую ссылку', async () => {
  const f = fixture();
  await f.tracker.resume();
  f.tracker.inviteCreated({ code: 'new', uses: 0, inviter: { id: 'other' } });
  f.next(snapshot([['one', 0, 'owner'], ['new', 1, 'other']]));
  const pending = f.tracker.join(member('a'));
  await f.tracker.flush(); await pending;
  assert.equal(f.events[0].inviterId, 'other');
});
