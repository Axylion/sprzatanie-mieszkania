import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../administracja/dyzury.js', import.meta.url), 'utf8');
const key = 'a491f135-b14e-45d2-a397-9db4846cc7df';
const jobStarted = Date.UTC(2026, 10, 24, 11);
const waitLimit = 240000;
const result = (status, deadline = jobStarted + waitLimit) => ({
  status, requestId: key, sent: status === 'sent' ? 1 : 0, total: 1,
  expiresAt: new Date(deadline).toISOString()
});
const never = () => new Promise(() => {});

class Element {
  constructor() {
    this.value = '1';
    this.textContent = '';
    this.listeners = new Map();
    this.classList = { add() {}, toggle() {} };
  }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  trigger(type) { return this.listeners.get(type)?.(); }
  dispatchEvent() {}
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

function setup(handler, storage = new Map(), missedDuties = async () => new Map()) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  element('admin-duties').hidden = true;
  const duty = name => element('admin-duty-' + name);
  const timers = new Map();
  let now = jobStarted;
  let timerId = 0;
  class MockDate extends Date { static now() { return now; } }
  const window = new Element();
  runInNewContext(script, {
    Event: class {},
    document: { getElementById: element, createElement: () => new Element() },
    window,
    g19AdminStatus: (element, message) => { element.textContent = message; },
    sessionStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    Date: MockDate,
    Option: class { constructor(text, value) { this.value = value; } },
    WEEK: 604800000,
    dayMs: 86400000,
    nearestSaturday: () => Date.UTC(2026, 10, 28),
    todayInPoland: () => Date.UTC(2026, 10, 24),
    roomFor: () => 1,
    weekendText: String,
    g19CalendarDetails: { missedDuties },
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

test('opening an existing job respects its original deadline during repeated network errors', async () => {
  const app = setup(async name => {
    if (name === 'duty_push_result') return result('pending');
    throw new Error('offline');
  });
  await app.advance(210000);
  await app.open();
  await app.advance(29999);
  assert.match(app.duty('push-feedback').textContent, /Oczekuje/);
  await app.advance(1);
  assert.match(app.duty('push-feedback').textContent, /Nie udało się potwierdzić wyniku/);
  assert.equal(app.duty('preview-push').textContent, app.duty('push-feedback').textContent);
  assert.equal(app.timers.size, 0);
});

test('reopening with a saved receipt preserves the deadline even during a hung refresh', async () => {
  const app = setup(async name => name === 'duty_push_result' ? result('pending') : never());
  await app.open();
  await app.advance(waitLimit - 1000);
  app.panel.setOpen(false);
  await app.open();
  await app.advance(999);
  assert.match(app.duty('push-feedback').textContent, /Oczekuje/);
  await app.advance(1);
  assert.match(app.duty('push-feedback').textContent, /Nie udało się potwierdzić wyniku/);
  app.panel.setOpen(false);
  await app.open();
  assert.doesNotMatch(app.duty('push-feedback').textContent, /Oczekuje/);
});

test('an old saved receipt cannot carry its grace period into the updated interface', async () => {
  const storage = new Map([['g19-manual-duty:1:2026-11-21', JSON.stringify({
    id: key, deadline: jobStarted + waitLimit + 8000, accepted: true
  })]]);
  const app = setup(async name => {
    assert.equal(name, 'duty_push_request');
    return never();
  }, storage);
  await app.advance(waitLimit - 2000);
  await app.open();
  assert.match(app.duty('push-feedback').textContent, /Oczekuje/);
  await app.advance(2000);
  assert.match(app.duty('push-feedback').textContent, /Nie udało się potwierdzić wyniku/);
});

test('a hung duty lookup does not delay the push result at the deadline', async () => {
  const app = setup(async () => result('pending'), new Map(), never);
  await app.advance(waitLimit - 1);
  await app.open();
  assert.match(app.duty('push-feedback').textContent, /Oczekuje/);
  await app.advance(1);
  assert.match(app.duty('push-feedback').textContent, /Nie udało się potwierdzić wyniku/);
});

test('an expired server failure is ambiguous, while failure before expiry is confirmed', async () => {
  const confirmed = setup(async () => result('failed'));
  await confirmed.open();
  assert.match(confirmed.duty('push-feedback').textContent, /Nie udało się wysłać/);

  const expired = setup(async () => result('failed'));
  await expired.advance(waitLimit);
  await expired.open();
  assert.match(expired.duty('push-feedback').textContent, /nie został potwierdzony/);
  assert.doesNotMatch(expired.duty('push-feedback').textContent, /Nie udało się wysłać/);
  assert.equal(expired.duty('send').disabled, false);
});

test('a hung submission can be retried with the same key and original deadline', async () => {
  let submissions = 0;
  const app = setup(async (name, args) => {
    if (name === 'send_duty') {
      assert.equal(args.p_request_id, key);
      if (++submissions === 1) return never();
      return result('pending', jobStarted + waitLimit + 8000);
    }
    if (name === 'duty_push_request') return never();
    return null;
  });
  await app.open();
  const first = app.send();
  await new Promise(resolve => setImmediate(resolve));
  await app.advance(8000);
  await first;
  assert.match(app.duty('push-feedback').textContent, /Nie potwierdzono zlecenia/);
  await app.send();
  assert.equal(submissions, 2);
  await app.advance(waitLimit - 8000);
  assert.match(app.duty('push-feedback').textContent, /Nie udało się potwierdzić wyniku/);
});

test('the status save and confirmed push submit remain independent', async () => {
  const calls = [];
  const app = setup(async (name, args) => {
    calls.push([name, args]);
    if (name === 'save_duty') return true;
    if (name === 'send_duty') return result('sent');
    return null;
  });
  await app.open();
  app.duty('missed').checked = true;
  app.duty('missed').trigger('change');
  await app.duty('save').trigger('click');
  assert.deepEqual(calls.map(([name]) => name), ['duty_push_result', 'save_duty']);
  assert.equal(calls[1][1].p_missed, true);
  const sending = app.duty('send').trigger('click');
  assert.equal(calls.length, 2);
  app.duty('confirm').confirm();
  await sending;
  assert.deepEqual(calls.map(([name]) => name), ['duty_push_result', 'save_duty', 'send_duty']);
  assert.equal(calls[2][1].p_request_id, key);
  assert.equal(calls[2][1].p_missed, undefined);
});
