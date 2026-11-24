import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const calendarScript = read('kalendarz/kalendarz.js');
const index = read('index.html');
const scheduleFunctions = index.slice(index.indexOf('  const BASE ='), index.indexOf('  const initialDay ='));
const calendarFunctions = index.slice(index.indexOf('  function dutyOn('), index.indexOf('  for (const [selector, offset]'));
const day = 86400000;
const date = value => Date.parse(value + 'T00:00:00Z');

test('month view starts on Monday and spans year and leap-day boundaries', () => {
  const context = {};
  runInNewContext(calendarScript, context);
  for (const [first, next, firstCell, lastCell] of [
    ['2026-11-01', '2026-12-01', '2026-10-26', '2026-12-06'],
    ['2027-01-01', '2027-02-01', '2026-12-28', '2027-01-31'],
    ['2028-03-01', '2028-04-01', '2028-02-28', '2028-04-02']
  ]) {
    const cells = context.g19CalendarDetails.monthDays(new Date(date(first)), new Date(date(next)));
    assert.equal(cells[0], date(firstCell));
    assert.equal(cells.at(-1), date(lastCell));
    assert.equal(cells.length % 7, 0);
    assert.ok(cells.every((value, i) => value === cells[0] + i * day));
  }
});

class Cell {
  constructor(tag) {
    this.tag = tag;
    this.attributes = {};
    this.dataset = {};
    this.classes = new Set();
    this.classList = { add: value => this.classes.add(value) };
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  append(child) { this.child = child; }
  replaceChildren(...cells) { this.cells = cells; }
}
function renderMonth({month, selectedRoom, missing = []}) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, new Cell('div'));
    return elements.get(id);
  };
  const context = {
    calendarMonth: new Date(date(month)), renderedLocalDay: 0, boundRoom: null, selectedRoom,
    missed: new Map(missing), monthFormat: { format: String }, closeCalendarTooltip() {},
    calendarDays: get('calendar-days'),
    document: { getElementById: get, createElement: tag => new Cell(tag) }
  };
  runInNewContext(calendarScript, context);
  runInNewContext(scheduleFunctions + calendarFunctions + 'renderCalendar();', context);
  return new Map(get('calendar-days').cells.map(cell => [Number(cell.dataset.date), cell]));
}
test('cross-month weekend keeps the same duty styling and only adjacent dates are muted', () => {
  for (const month of ['2026-10-01', '2026-11-01']) {
    const cells = renderMonth({month, selectedRoom: '3'});
    const saturday = cells.get(date('2026-10-31'));
    const sunday = cells.get(date('2026-11-01'));
    assert.equal(saturday.child.textContent, 31);
    assert.equal(sunday.child.textContent, 1);
    for (const cell of [saturday, sunday]) {
      assert.ok(cell.classes.has('calendar-weekend'));
      assert.ok(cell.classes.has('calendar-own'));
      assert.match(cell.attributes['aria-label'], /dyżur: pokój 3/);
    }
    assert.equal(saturday.classes.has('calendar-adjacent'), month.endsWith('11-01'));
    assert.notEqual(saturday.classes.has('calendar-adjacent'), sunday.classes.has('calendar-adjacent'));
    assert.ok(sunday.classes.has('calendar-holiday'));
    assert.match(sunday.dataset.details, /Wszystkich Świętych/);
  }
});
test('a missed duty has red background or red indicator on both boundary dates and preserves tooltip details', () => {
  for (const [room, indicator] of [['3', 'own'], ['1', 'other']]) {
    const cells = renderMonth({month: '2026-11-01', selectedRoom: room, missing: [['2026-10-31', 3]]});
    for (const value of ['2026-10-31', '2026-11-01']) {
      const cell = cells.get(date(value));
      assert.ok(cell.classes.has('calendar-missed-' + indicator));
      assert.equal(cell.tag, 'button');
      assert.match(cell.dataset.details, /Dyżur niewykonany.*3/);
    }
    assert.match(cells.get(date('2026-11-01')).dataset.details, /Wszystkich Świętych/);
  }
  const december = renderMonth({month: '2026-12-01', selectedRoom: '1'});
  assert.match(december.get(date('2027-01-01')).dataset.details, /Nowy Rok/);
});

function installer(userAgent, options = {}) {
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) {
      const handlers = new Map();
      nodes.set(id, {
        hidden: false, innerHTML: '',
        addEventListener: (type, callback) => handlers.set(type, callback),
        trigger: (type, event) => handlers.get(type)(event),
        showModal() { this.open = true; },
        close() { this.open = false; }
      });
    }
    return nodes.get(id);
  };
  const storage = new Map();
  const window = element('window');
  window.matchMedia = () => ({matches: options.standalone ?? false, addEventListener() {}});
  runInNewContext(read('pwa-install.js'), {
    window, navigator: {userAgent, platform: options.platform, maxTouchPoints: options.points},
    document: {getElementById: element},
    localStorage: {getItem: key => storage.get(key), setItem: (k,v) => storage.set(k,v), removeItem: key => storage.delete(key)}
  });
  return { element, window, storage };
}
for (const [name, ua, expected] of [
  ['Firefox on Android', 'Mozilla Android Firefox/150', /W Firefox.*ekranie głównym/],
  ['desktop Firefox', 'Mozilla Linux Firefox/150', /Firefox na komputerze.*Chrome lub Edge/],
  ['Safari on iPhone', 'Mozilla iPhone Version/26 Safari/605', /Udostępnij.*Do ekranu początkowego/],
  ['Chrome without an install prompt', 'Mozilla Chrome/150', /W Chrome lub Edge.*pasku adresu/]
]) {
  test(name + ' gives one applicable instruction without a synthetic install button', () => {
    const {element} = installer(ua);
    element('shortcut-open').trigger('click');
    assert.match(element('shortcut-instructions').innerHTML, expected);
    assert.equal(element('native-install').hidden, true);
  });
}
test('Chromium native install prompt takes precedence and an installed app hides the affordance', async () => {
  for (const ua of ['Mozilla Chrome/150', 'Mozilla Chrome/150 Edg/150']) {
    const {element, window, storage} = installer(ua);
    const invoked = [];
    window.trigger('beforeinstallprompt', {
      preventDefault: () => invoked.push('prevented'), prompt: async () => invoked.push('native')
    });
    element('shortcut-open').trigger('click');
    assert.equal(element('native-install').hidden, false);
    await element('native-install').trigger('click');
    assert.deepEqual(invoked, ['prevented', 'native']);
    window.trigger('appinstalled');
    assert.equal(storage.get('goleszan19-installed'), 'true');
    assert.equal(element('shortcut-open').hidden, true);
  }
  assert.equal(installer('Safari iPhone', {standalone:true}).element('shortcut-open').hidden, true);
});
