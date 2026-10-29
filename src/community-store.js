import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

export const DEFAULT_WELCOME = 'Привет, {member}! Добро пожаловать на {server}! Пригласил: {inviter}.';
const settingsKeys = new Set(['welcomeChannelId', 'leaveChannelId', 'logChannelId', 'welcomeTemplate']);

// Discord ID всегда TEXT: Number теряет точность больших snowflake.
export class CommunityStore {
  constructor(path, guildId, now = Date.now) {
    this.guildId = guildId;
    this.now = now;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > 1) throw new Error('База создана более новой версией LazyBot.');
      this.db.exec(`
        BEGIN;
        CREATE TABLE IF NOT EXISTS community_settings (
          guild_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
          PRIMARY KEY (guild_id, key)
        );
        CREATE TABLE IF NOT EXISTS community_meta (
          guild_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS invite_labels (
          guild_id TEXT NOT NULL, code TEXT NOT NULL, label TEXT NOT NULL,
          PRIMARY KEY (guild_id, code)
        );
        CREATE TABLE IF NOT EXISTS community_members (
          guild_id TEXT NOT NULL, user_id TEXT NOT NULL, present INTEGER NOT NULL,
          joined_at INTEGER, first_inviter_id TEXT, first_invite_code TEXT,
          bot INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY (guild_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS community_events (
          id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
          type TEXT NOT NULL, at INTEGER NOT NULL, inviter_id TEXT, invite_code TEXT,
          source TEXT NOT NULL, label TEXT, rejoin INTEGER NOT NULL,
          young INTEGER NOT NULL, bot INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS community_events_period ON community_events(guild_id, at);
        CREATE INDEX IF NOT EXISTS community_events_member ON community_events(guild_id, user_id, id);
        PRAGMA user_version = 1;
        COMMIT;
      `);
      this.db.prepare('INSERT OR IGNORE INTO community_meta VALUES (?, ?)').run(guildId, now());
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  get startedAt() {
    return this.db.prepare('SELECT started_at FROM community_meta WHERE guild_id = ?').get(this.guildId).started_at;
  }

  settings() {
    const rows = this.db.prepare('SELECT key, value FROM community_settings WHERE guild_id = ?').all(this.guildId);
    return { welcomeTemplate: DEFAULT_WELCOME, ...Object.fromEntries(rows.map(row => [row.key, row.value])) };
  }

  configure(values) {
    for (const key of Object.keys(values)) if (!settingsKeys.has(key)) throw new Error('Неизвестная настройка.');
    this.transaction(() => {
      const upsert = this.db.prepare('INSERT INTO community_settings VALUES (?, ?, ?) ON CONFLICT(guild_id, key) DO UPDATE SET value = excluded.value');
      const remove = this.db.prepare('DELETE FROM community_settings WHERE guild_id = ? AND key = ?');
      for (const [key, value] of Object.entries(values)) {
        if (value === null) remove.run(this.guildId, key);
        else upsert.run(this.guildId, key, String(value));
      }
    });
  }

  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  member(userId) {
    return this.db.prepare('SELECT * FROM community_members WHERE guild_id = ? AND user_id = ?').get(this.guildId, userId);
  }

  insertEvent({ userId, type, at, inviterId = null, code = null, source = 'unknown', label = null, rejoin = false, young = false, bot = false }) {
    this.db.prepare('INSERT INTO community_events (guild_id, user_id, type, at, inviter_id, invite_code, source, label, rejoin, young, bot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.guildId, userId, type, at, inviterId, code, source, label, Number(rejoin), Number(young), Number(bot));
  }

  join({ userId, joinedAt, createdAt, bot = false, attribution = {} }) {
    return this.transaction(() => {
      const previous = this.member(userId);
      // Gateway может повторно прислать memberAdd существующего участника.
      if (previous?.joined_at !== null && previous?.joined_at >= joinedAt) return null;
      const rejoin = Boolean(previous);
      const inviterId = !bot && attribution.source === 'invite' && attribution.inviterId !== userId
        ? attribution.inviterId ?? null : null;
      const young = !bot && Number.isFinite(createdAt) && joinedAt - createdAt < 7 * 86400_000;
      const label = attribution.code ? this.label(attribution.code) : null;
      const source = bot ? 'bot' : attribution.source ?? 'unknown';
      this.db.prepare(`
        INSERT INTO community_members VALUES (?, ?, 1, ?, ?, ?, ?, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET
          present = 1, joined_at = excluded.joined_at, bot = excluded.bot, updated_at = excluded.updated_at
      `).run(this.guildId, userId, joinedAt, !rejoin ? inviterId : null,
        !rejoin ? attribution.code ?? null : null, Number(bot), this.now());
      const event = { userId, type: 'join', at: joinedAt, inviterId, code: attribution.code ?? null, source, label, rejoin, young, bot };
      this.insertEvent(event);
      return event;
    });
  }

  leave(userId, bot = false, at = this.now()) {
    return this.transaction(() => {
      const previous = this.member(userId);
      if (previous?.present === 0 || (previous?.joined_at && previous.joined_at > at)) return null;
      this.db.prepare(`
        INSERT INTO community_members VALUES (?, ?, 0, NULL, NULL, NULL, ?, ?)
        ON CONFLICT(guild_id, user_id) DO UPDATE SET present = 0, updated_at = excluded.updated_at
      `).run(this.guildId, userId, Number(bot), this.now());
      const lastJoin = this.lastJoin(userId);
      const event = { userId, type: 'leave', at, bot: Boolean(previous?.bot ?? bot),
        inviterId: lastJoin?.inviter_id ?? null, code: lastJoin?.invite_code ?? null,
        source: lastJoin?.source ?? 'unknown', label: lastJoin?.label ?? null };
      this.insertEvent(event);
      return event;
    });
  }

  lastJoin(userId) {
    return this.db.prepare("SELECT * FROM community_events WHERE guild_id = ? AND user_id = ? AND type = 'join' ORDER BY id DESC LIMIT 1").get(this.guildId, userId);
  }

  invites(userId) {
    return this.db.prepare(`
      SELECT COUNT(*) AS total, COALESCE(SUM(present = 1), 0) AS present,
        COALESCE(SUM(present = 0), 0) AS left, COALESCE(SUM(present = -1), 0) AS unverified
      FROM community_members WHERE guild_id = ? AND first_inviter_id = ? AND bot = 0
    `).get(this.guildId, userId);
  }

  top(since = 0) {
    return this.db.prepare(`
      SELECT e.inviter_id AS userId, COUNT(*) AS total,
        SUM(m.present = 1) AS present
      FROM community_events e JOIN community_members m ON m.guild_id = e.guild_id AND m.user_id = e.user_id
      WHERE e.guild_id = ? AND e.type = 'join' AND e.rejoin = 0 AND e.bot = 0
        AND e.inviter_id IS NOT NULL AND e.at >= ?
      GROUP BY e.inviter_id ORDER BY total DESC, e.inviter_id ASC LIMIT 10
    `).all(this.guildId, since);
  }

  stats(since = 0) {
    return this.db.prepare(`
      SELECT COALESCE(SUM(type = 'join'), 0) AS joins, COALESCE(SUM(type = 'leave'), 0) AS leaves,
        COALESCE(SUM(type = 'join' AND rejoin = 1), 0) AS rejoins,
        COALESCE(SUM(type = 'join' AND source = 'unknown'), 0) AS unknown,
        COALESCE(SUM(type = 'join' AND young = 1), 0) AS young
      FROM community_events WHERE guild_id = ? AND at >= ? AND bot = 0
    `).get(this.guildId, since);
  }

  sources(since = 0) {
    return this.db.prepare(`
      SELECT COALESCE(label, invite_code, source) AS name, COUNT(*) AS total
      FROM community_events WHERE guild_id = ? AND type = 'join' AND bot = 0 AND at >= ?
      GROUP BY name ORDER BY total DESC, name ASC LIMIT 10
    `).all(this.guildId, since);
  }

  label(code) {
    return this.db.prepare('SELECT label FROM invite_labels WHERE guild_id = ? AND code = ?').get(this.guildId, code)?.label ?? null;
  }

  setLabel(code, label) {
    if (label === null) this.db.prepare('DELETE FROM invite_labels WHERE guild_id = ? AND code = ?').run(this.guildId, code);
    else this.db.prepare('INSERT INTO invite_labels VALUES (?, ?, ?) ON CONFLICT(guild_id, code) DO UPDATE SET label = excluded.label')
      .run(this.guildId, code, label);
  }

  labels() {
    return this.db.prepare('SELECT code, label FROM invite_labels WHERE guild_id = ? ORDER BY code').all(this.guildId);
  }

  markPresenceUnknown() {
    this.db.prepare('UPDATE community_members SET present = -1 WHERE guild_id = ? AND present = 1').run(this.guildId);
    return this.db.prepare('SELECT user_id, joined_at, updated_at FROM community_members WHERE guild_id = ? AND present = -1').all(this.guildId);
  }

  reconcilePresence(userId, joinedAt, present, expectedUpdatedAt) {
    // HTTP-ответ не должен перезаписать более свежее событие Gateway.
    const member = this.member(userId);
    if (member?.present !== -1 || member.updated_at !== expectedUpdatedAt) return;
    this.db.prepare('UPDATE community_members SET present = ? WHERE guild_id = ? AND user_id = ? AND present = -1')
      .run(present ? 1 : 0, this.guildId, userId);
    // Незамеченные офлайн входы/выходы не выдаём за события с известным временем.
    if (present && joinedAt !== null && joinedAt !== member.joined_at) {
      this.db.prepare('UPDATE community_members SET joined_at = ? WHERE guild_id = ? AND user_id = ?')
        .run(joinedAt, this.guildId, userId);
    }
  }

  backup(path) { return backup(this.db, path); }
  close() { this.db.close(); }
}
