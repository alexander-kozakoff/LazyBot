import { EMPTY_DELAY_MS, RECONCILE_INTERVAL_MS, ROOM_PREFIX } from './config.js';
import { explainError } from './logger.js';

function roomNumber(name) {
  const match = /^Комната ([1-9]\d*)$/.exec(name);
  return match ? Number(match[1]) : Infinity;
}

export function compareRooms(a, b) {
  const first = roomNumber(a.name);
  const second = roomNumber(b.name);
  if (first !== second) return first < second ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function nextRoomName(rooms) {
  const used = new Set(rooms.map(room => roomNumber(room.name)));
  let number = 1;
  while (used.has(number)) number += 1;
  return `${ROOM_PREFIX} ${number}`;
}

// Вся работа с Discord проходит через adapter; алгоритм проверяется без токена.
export class RoomManager {
  constructor(adapter, logger, {
    now = () => performance.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    emptyDelayMs = EMPTY_DELAY_MS,
    retryMs = RECONCILE_INTERVAL_MS,
  } = {}) {
    Object.assign(this, { adapter, logger, now, setTimer, clearTimer, emptyDelayMs, retryMs });
    this.emptySince = new Map();
    this.pending = false;
    this.running = null;
    this.stopped = false;
    this.suspended = false;
    this.retryAfter = 0;
    this.timer = null;
  }

  // Обновляем таймер прямо при событии: даже быстрый вход-выход во время
  // незавершённого HTTP-запроса прерывает прежний период пустоты.
  voiceChanged(oldChannelId, newChannelId) {
    if (oldChannelId === newChannelId) return this.running ?? Promise.resolve();
    if (newChannelId) this.emptySince.delete(newChannelId);
    if (oldChannelId) this.emptySince.delete(oldChannelId);
    return this.request();
  }

  request() {
    if (this.stopped || this.suspended) return Promise.resolve();
    this.pending = true;
    if (!this.running) {
      this.running = this.drain().finally(() => {
        this.running = null;
        if (this.pending && !this.stopped) void this.request();
      });
    }
    return this.running;
  }

  async drain() {
    while (this.pending && !this.stopped && !this.suspended) {
      this.pending = false;
      if (this.now() < this.retryAfter) {
        this.schedule(this.retryAfter - this.now());
        return;
      }
      try {
        await this.reconcile();
      } catch (error) {
        this.emptySince.clear();
        this.retryAfter = this.now() + this.retryMs;
        this.logger.warn(explainError(error));
        this.schedule(this.retryMs);
        return;
      }
    }
  }

  schedule(delay) {
    if (this.stopped || this.suspended) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.request();
    }, Math.max(1, delay));
    this.timer?.unref?.();
  }

  observe(rooms) {
    const present = new Set(rooms.map(room => room.id));
    for (const id of this.emptySince.keys()) {
      if (!present.has(id)) this.emptySince.delete(id);
    }
    for (const room of rooms) {
      if (room.members > 0) this.emptySince.delete(room.id);
      else if (!this.emptySince.has(room.id)) this.emptySince.set(room.id, this.now());
    }
  }

  async reconcile() {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    let rooms = await this.adapter.listRooms();
    if (this.stopped || this.suspended) return;
    this.observe(rooms);
    const empty = rooms.filter(room => room.members === 0).sort(compareRooms);
    if (empty.length === 0) {
      const name = nextRoomName(rooms);
      const created = await this.adapter.createRoom(name);
      if (created !== false) this.logger.info(`Создана свободная ${name}.`);
      return;
    }

    // Первый по номеру пустой канал оставляем. Перед каждым удалением
    // заново читаем каналы и актуальные голосовые состояния из Gateway.
    for (const candidate of empty.slice(1)) {
      rooms = await this.adapter.listRooms();
      if (this.stopped || this.suspended) return;
      this.observe(rooms);
      const currentEmpty = rooms.filter(room => room.members === 0).sort(compareRooms);
      const room = currentEmpty.find(item => item.id === candidate.id);
      if (!room || currentEmpty.length < 2 || currentEmpty[0].id === room.id) continue;
      const remaining = this.emptyDelayMs - (this.now() - this.emptySince.get(room.id));
      if (remaining > 0) continue;
      // Между последней проверкой и запросом удаления нет другого await.
      if (this.adapter.isRoomEmpty(room.id)) {
        const deleted = await this.adapter.deleteRoom(room.id);
        if (deleted !== false) {
          this.emptySince.delete(room.id);
          this.logger.info(`Удалена лишняя пустая ${room.name}. Её встроенный чат удалён вместе с каналом.`);
        }
      }
    }

    rooms = await this.adapter.listRooms();
    if (this.stopped || this.suspended) return;
    this.observe(rooms);
    const remainingEmpty = rooms.filter(room => room.members === 0).sort(compareRooms);
    if (remainingEmpty.length === 0) {
      this.pending = true;
    } else if (remainingEmpty.length > 1) {
      const next = Math.min(...remainingEmpty.slice(1).map(room =>
        this.emptyDelayMs - (this.now() - this.emptySince.get(room.id))));
      this.schedule(Math.max(100, next));
    }
  }

  pause() {
    // При разрыве соединения не доверяем прежним данным о пустоте.
    this.suspended = true;
    this.pending = false;
    this.emptySince.clear();
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  resume() {
    this.emptySince.clear();
    this.suspended = false;
    this.retryAfter = 0;
    return this.request();
  }

  stop() {
    this.stopped = true;
    this.pending = false;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
}
