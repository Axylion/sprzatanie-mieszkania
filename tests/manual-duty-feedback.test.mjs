import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../administracja/dyzury.js', import.meta.url), 'utf8');
const key = 'a491f135-b14e-45d2-a397-9db4846cc7df';
const result = status => ({ status, requestId: key, sent: status === 'sent' ? 1 : 0, total: 1 });

class Element {
  constructor() {
    this.value = '1';
    this.textContent = '';
    this.listeners = new Map();
    this.classList = { add() {} };
  }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  trigger(type) { return this.listeners.get(type)?.(); }
  append() {}
  replaceChildren(...children) { this.options = children; }
  querySelector() { return new Element(); }
  showModal() { this.open = true; }
  confirm() {
    this.open = false;
    this.returnValue = 'confirm';
    this.trigger('close');
  }
}

function setup(handler, storage = new Map()) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  element('admin-duties').hidden = true;
  const duty = name => element('admin-duty-' + name);
  const timers = new Map();
  let now = Date.UTC(2026, 10, 24, 11);
  let timerId = 0;
  class MockDate extends Date { static now() { return now; } }
  const window = new Element();
  runInNewContext(script, {
    document: { getElementById: element, createElement: () => new Element() },
    window,
    sessionStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    Date: MockDate,
    Option: class { constructor(text, value) { this.value = value; } },
    WEEK: 604800000,
    dayMs: 86400000,
    nearestSaturday: () => Date.UTC(2026, 10, 28),
    todayInPoland: () => Date.UTC(2026, 10, 24),
    roomFor: () => 1,
    weekendText: String,
    g19CalendarDetails: { missedDuties: async () => new Map() },
    crypto: { randomUUID: () => key },
    setTimeout: (callback, delay) => {
      timers.set(++timerId, { callback, at: now + delay });
      return timerId;
    },
    clearTimeout: id => timers.delete(id)
  });
  const panel = window.g19AdminDuties;
  panel.init(handler, () => panel.reset());
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return {
    duty, panel, storage, timers,
    async open() { panel.setOpen(true); await flush(); },
    async send() {
      const operation = duty('send').trigger('click');
      duty('confirm').confirm();
      await operation;
    },
    async advance(ms) {
      const end = now + ms;
      while (timers.size) {
        const [id, timer] = [...timers].sort((a,b) => a[1].at - b[1].at)[0];
        if (timer.at > end) break;
        now = timer.at;
        timers.delete(id);
        timer.callback();
        await flush();
      }
      now = end;
    }
  };
}

test('manual duty updates both live feedback and preview with the exact job result', async () => {
  const app = setup(async (name, args) => {
    if (name === 'send_duty') return result('pending');
    if (name === 'duty_push_request') {
      assert.equal(args.p_request_id, key);
      return result('sent');
    }
    return null;
  });
  await app.open();
  await app.send();
  assert.equal(app.duty('push-feedback').textContent, 'Oczekuje na wynik wysyłki.');
  assert.equal(app.duty('send').disabled, true);
  await app.advance(4000);
  assert.match(app.duty('push-feedback').textContent, /Usługa push przyjęła.*\(1\/1\)/);
  assert.equal(app.duty('preview-push').textContent, app.duty('push-feedback').textContent);
  assert.equal(app.duty('send').disabled, false);
  assert.equal(app.timers.size, 0);
});

test('manual duty polling stops after four minutes if requests fail or never resolve', async () => {
  for (const forever of [false, true]) {
    const app = setup(async (name) => {
      if (name === 'send_duty') return result('pending');
      if (name === 'duty_push_request') {
        if (forever) return new Promise(() => {});
        throw new Error('offline');
      }
      return null;
    });
    await app.open();
    await app.send();
    await app.advance(240000);
    assert.match(app.duty('push-feedback').textContent, /Nie udało się potwierdzić wyniku/);
    assert.equal(app.duty('send').disabled, true);
    assert.equal(app.timers.size, 0);
  }
});

test('a lost submission response retains its idempotency key after a reload', async () => {
  const app = setup(async (name) => {
    if (name === 'send_duty') throw new Error('response lost');
    return null;
  });
  await app.open();
  await app.send();
  assert.match(app.duty('push-feedback').textContent, /Nie potwierdzono zlecenia/);
  let checked = false;
  const reloaded = setup(async (name, args) => {
    assert.equal(name, 'duty_push_request');
    assert.equal(args.p_request_id, key);
    checked = true;
    return result('sent');
  }, app.storage);
  await reloaded.open();
  assert.equal(checked, true);
  assert.match(reloaded.duty('push-feedback').textContent, /Usługa push przyjęła/);
});
