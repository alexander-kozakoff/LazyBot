import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommunityStore } from '../src/community-store.js';
import { backupCommunity } from '../src/community-backup.js';

const guildId = '1111667504276836523';
const inviterId = '123456789012345678';
const otherInviter = '987654321098765432';
const userId = '234567890123456789';
const start = 1800000000000;
const attribution = { source: 'invite', code: 'friends', inviterId };

function fixture(t) {
  let now = start;
  const store = new CommunityStore(':memory:', guildId, () => now);
  t.after(() => store.close());
  return {
    store, advance(ms = 1000) { now += ms; },
    join(options = {}) { return store.join({ userId, joinedAt: now, createdAt: start - 30 * 86400_000, attribution, ...options }); },
  };
}

test('приглашения: первый вход, выход, возвращение и смена ссылки не удваивают счёт', t => {
  const f = fixture(t);
  f.join();
  assert.deepEqual({ ...f.store.invites(inviterId) }, { total: 1, present: 1, left: 0, unverified: 0 });
  assert.equal(f.join(), null);
  f.advance();
  f.store.leave(userId);
  assert.equal(f.store.invites(inviterId).left, 1);
  assert.equal(f.store.leave(userId), null);
  f.advance();
  assert.equal(f.join({ attribution: { source: 'invite', code: 'other', inviterId: otherInviter } }).rejoin, true);
  assert.equal(f.store.invites(inviterId).total, 1);
  assert.equal(f.store.invites(inviterId).present, 1);
  assert.equal(f.store.invites(otherInviter).total, 0);
  assert.equal(f.store.lastJoin(userId).inviter_id, otherInviter);
});

test('боты, само-приглашения и неизвестные источники не добавляют баллы; молодой аккаунт учитывается', t => {
  const f = fixture(t);
  f.join({ bot: true });
  f.join({ userId: 'human-unknown', attribution: { source: 'unknown' } });
  f.join({ userId: inviterId });
  const young = f.join({ userId: 'young', createdAt: start - 86400_000 });
  assert.equal(young.young, true);
  assert.equal(f.store.invites(inviterId).total, 1);
  assert.equal(f.store.stats().joins, 3);
  assert.equal(f.store.stats().unknown, 1);
  assert.equal(f.store.stats().young, 1);
});

test('выход старого участника без истории записывается, а возвращение не выдаётся за первое приглашение', t => {
  const f = fixture(t);
  f.store.leave(userId);
  f.advance();
  assert.equal(f.join().rejoin, true);
  assert.equal(f.store.invites(inviterId).total, 0);
});

test('метки сохраняются на момент события; данные сервера, периоды и ID изолированы', t => {
  const f = fixture(t);
  f.store.setLabel('friends', 'Друзья');
  f.join();
  f.store.setLabel('friends', "YouTube' OR 1=1");
  f.advance(2 * 86400_000);
  f.join({ userId: 'new-user' });
  assert.equal(f.store.lastJoin(userId).label, 'Друзья');
  assert.equal(f.store.sources(start + 86400_000)[0].name, "YouTube' OR 1=1");
  assert.equal(f.store.stats(start + 86400_000).joins, 1);
  assert.equal(f.store.top(start + 86400_000)[0].total, 1);
  assert.equal(f.store.top()[0].userId, inviterId);
  assert.equal(f.store.invites(inviterId).total, 2);
});

test('неизвестное присутствие после разрыва отличается от ухода; HTTP не перезаписывает свежий Gateway', t => {
  const f = fixture(t);
  f.join();
  const [row] = f.store.markPresenceUnknown();
  assert.equal(f.store.invites(inviterId).unverified, 1);
  f.store.reconcilePresence(userId, null, false, row.updated_at);
  assert.equal(f.store.invites(inviterId).left, 1);
  // Восстановление присутствия не придумывает время пропущенного выхода.
  assert.equal(f.store.stats().leaves, 0);
  f.advance();
  f.join();
  const [next] = f.store.markPresenceUnknown();
  f.advance();
  f.store.leave(userId);
  f.store.reconcilePresence(userId, next.joined_at, true, next.updated_at);
  assert.equal(f.store.member(userId).present, 0);
});

test('повторный Gateway event после разрыва не превращается в новый вход', t => {
  const f = fixture(t);
  f.join();
  f.store.markPresenceUnknown();
  assert.equal(f.join(), null);
  assert.equal(f.store.stats().joins, 1);
});

test('SQLite сохраняет настройки и историю после открытия, резервная копия восстанавливается', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'lazybot-store-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'data.sqlite');
  let store = new CommunityStore(path, guildId, () => start);
  store.configure({ welcomeChannelId: '444444444444444444', welcomeTemplate: 'Привет, {member}!' });
  store.setLabel('friends', 'Друзья');
  store.join({ userId, joinedAt: start, attribution });
  const snapshot = await backupCommunity(store, path, new Date(start));
  store.close();
  store = new CommunityStore(path, guildId);
  assert.equal(store.settings().welcomeChannelId, '444444444444444444');
  assert.equal(store.invites(inviterId).total, 1);
  assert.equal(store.label('friends'), 'Друзья');
  store.close();
  const restored = new CommunityStore(snapshot, guildId);
  assert.equal(restored.invites(inviterId).total, 1);
  restored.close();
  const other = new CommunityStore(path, '999999999999999999');
  assert.equal(other.invites(inviterId).total, 0);
  assert.equal(other.settings().welcomeChannelId, undefined);
  other.close();
});
