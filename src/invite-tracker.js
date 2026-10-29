export function attributeJoins(before, after, count) {
  if (!before || !after || !count) return { source: 'unknown' };
  const changed = [];
  for (const [code, invite] of before.invites) {
    const current = after.invites.get(code);
    // Удалённая одноразовая ссылка могла быть использована последним вошедшим.
    if (!current || current.uses < invite.uses) return { source: 'unknown' };
    const delta = current.uses - invite.uses;
    if (delta > 0) changed.push({ source: 'invite', code, inviterId: current.inviterId, delta });
  }
  for (const [code, invite] of after.invites) {
    // Не считаем, что новая для нас ссылка раньше имела ноль использований.
    if (!before.invites.has(code) && invite.uses > 0) return { source: 'unknown' };
  }
  if (before.vanity?.code !== after.vanity?.code) return { source: 'unknown' };
  if (before.vanity && after.vanity) {
    const delta = after.vanity.uses - before.vanity.uses;
    if (delta < 0) return { source: 'unknown' };
    if (delta > 0) changed.push({ source: 'vanity', code: after.vanity.code, delta });
  }
  // Несколько разных ссылок не позволяют сопоставить участников и источники.
  if (changed.length !== 1 || changed[0].delta !== count) return { source: 'unknown' };
  const { source, code, inviterId } = changed[0];
  return { source, code, inviterId: inviterId ?? null };
}

// Очередь сохраняет порядок входов/выходов, объединяя близкие входы в один GET.
export class InviteTracker {
  constructor({ readSnapshot, onJoin, onLeave, onError, setTimer = setTimeout, clearTimer = clearTimeout, delayMs = 750 }) {
    Object.assign(this, { readSnapshot, onJoin, onLeave, onError, setTimer, clearTimer, delayMs });
    this.snapshot = null;
    this.epoch = 0;
    this.pending = [];
    this.running = null;
    this.timer = null;
    this.stopped = false;
    this.paused = true;
  }

  async resume() {
    const epoch = ++this.epoch;
    this.snapshot = null;
    this.paused = true;
    try {
      const snapshot = await this.readSnapshot();
      if (epoch === this.epoch && !this.stopped) {
        this.snapshot = snapshot;
        this.paused = false;
      }
    } catch {
      this.onError();
    }
  }

  pause() {
    this.epoch += 1;
    this.snapshot = null;
    this.paused = true;
  }

  inviteCreated(invite) {
    if (!this.snapshot || this.snapshot.invites.has(invite.code) || invite.uses !== 0) return;
    this.snapshot.invites.set(invite.code, { uses: 0, inviterId: invite.inviter?.id ?? null });
  }

  enqueue(event) {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.pending.push({ ...event, resolve, reject });
      if (this.timer === null && !this.running) {
        this.timer = this.setTimer(() => {
          this.timer = null;
          void this.flush();
        }, this.delayMs);
      }
    });
  }

  join(member) { return this.enqueue({ type: 'join', member }); }
  leave(member, at) { return this.enqueue({ type: 'leave', member, at }); }

  flush() {
    if (this.running) return this.running;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.running = this.drain().finally(() => {
      this.running = null;
      if (this.pending.length) void this.flush();
    });
    return this.running;
  }

  async drain() {
    while (this.pending.length) {
      const batch = this.pending.splice(0);
      const epoch = this.epoch;
      // Повторный Gateway event в одной пачке не увеличивает ожидаемый delta.
      const joins = new Set(batch.filter(event => event.type === 'join' && !event.member.user.bot)
        .map(event => event.member.id + ':' + event.member.joinedTimestamp));
      let attribution = { source: 'unknown' };
      if (joins.size && !this.paused && !this.stopped) {
        try {
          const next = await this.readSnapshot();
          if (epoch === this.epoch) {
            attribution = attributeJoins(this.snapshot, next, joins.size);
            this.snapshot = next;
          }
        } catch {
          this.snapshot = null;
          this.onError();
        }
      }
      for (const event of batch) {
        try {
          if (event.type === 'join') await this.onJoin(event.member, attribution);
          else await this.onLeave(event.member, event.at);
          event.resolve();
        } catch {
          // Ошибки не содержат данные запроса или секреты.
          this.onError();
          event.reject(new Error('Не удалось сохранить событие сообщества.'));
        }
      }
    }
  }

  async stop() {
    this.stopped = true;
    this.pause();
    await this.flush();
  }
}
