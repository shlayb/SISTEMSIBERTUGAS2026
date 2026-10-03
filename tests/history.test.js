import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../history.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../assets/js/history.js', import.meta.url), 'utf8');
const event = { eventId: 'boot-1', deviceId: 'server-01', source: 'device', occurredAt: '2026-10-03T01:02:03.000Z', receivedAt: '2026-10-03T01:03:00.000Z', temperature: 27, humidity: 45, smoke: 75, setpoint: 30, status: 'NORMAL', servo: 0, buzzer: false, led: 'green', eventType: 'TELEMETRY', replay: false };
const page = (items = [event], nextCursor = null) => Response.json({ items, nextCursor, retentionDays: 7, snapshotAt: event.receivedAt });
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(setImmediate); }
  assert.fail('DOM did not reach expected state');
}
function setup(fetchImpl = async () => page()) {
  const dom = new JSDOM(html, { url: 'https://example.test/history.html', runScripts: 'outside-only' });
  const { window } = dom;
  const calls = [], intervals = [], blobs = [], downloads = [];
  window.fetch = (url, options) => { calls.push({ url, options }); return fetchImpl(url, options, calls.length); };
  window.setInterval = fn => { intervals.push(fn); return intervals.length; };
  window.clearInterval = () => {};
  window.Blob = Blob;
  window.URL.createObjectURL = blob => { blobs.push(blob); return 'blob:test'; };
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
  Object.defineProperty(window.document, 'hidden', { value: false, configurable: true });
  window.eval(script);
  const $ = id => window.document.getElementById(id);
  const ready = () => until(() => $('historyResults').getAttribute('aria-busy') === 'false');
  const submit = () => $('historyFilters').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  return { dom, window, $, calls, intervals, blobs, downloads, ready, submit };
}

test('history reads public data, renders text safely, applies UTC filters, and exports applied filters', async () => {
  const t = setup(async () => page([{ ...event, eventId: '<img src=x onerror=alert(1)>' }]));
  try {
    await t.ready();
    assert.match(t.$('historyRows').textContent, /server-01/);
    assert.equal(t.$('historyRows').querySelector('img'), null);
    t.$('logDevice').value = 'server-01'; t.$('logStatus').value = 'NORMAL';
    t.$('logFrom').value = '2026-10-03T01:00:00'; t.$('logTo').value = '2026-10-03T02:00:00';
    t.submit(); await t.ready();
    const params = new URL(t.calls.at(-1).url, 'https://example.test').searchParams;
    assert.equal(params.get('from'), '2026-10-03T01:00:00.000Z'); assert.equal(params.get('status'), 'NORMAL');
    t.$('logDevice').value = 'unsaved-filter';
    t.$('exportLogs').click(); await until(() => t.downloads.length === 1);
    assert.equal(new URL(t.calls.at(-1).url, 'https://example.test').searchParams.get('deviceId'), 'server-01');
    assert.ok(t.calls.every(call => call.url.startsWith('/api/logs?') && !call.options.method && !call.options.headers));
  } finally { t.dom.window.close(); }
});

test('cursor navigation pauses polling on old pages and handles empty/error results', async () => {
  let fail = false, empty = false;
  const t = setup(async url => fail ? Response.json({}, { status: 503 }) : empty ? page([]) : new URL(url, 'https://example.test').searchParams.has('cursor') ? page([{ ...event, eventId: 'older-event' }]) : page([event], 'next-cursor'));
  try {
    await t.ready(); t.$('nextLogs').click(); await t.ready();
    assert.equal(t.$('historyPage').textContent, 'Halaman 2');
    const calls = t.calls.length; t.intervals[0](); await new Promise(setImmediate); assert.equal(t.calls.length, calls);
    fail = true; t.$('refreshLogs').click(); await t.ready();
    assert.match(t.$('historyMessage').textContent, /Database riwayat/); assert.match(t.$('historyRows').textContent, /older-event/);
    assert.equal(t.$('nextLogs').disabled, true);
    fail = false; empty = true; t.$('refreshLogs').click(); await t.ready();
    assert.match(t.$('historyMessage').textContent, /Belum ada log/); assert.equal(t.$('historyRows').children.length, 0);
    const prior = t.calls.length; t.intervals[0](); await t.ready(); assert.equal(t.calls.length, prior + 1);
  } finally { t.dom.window.close(); }
});

test('CSV follows all cursors including empty pages and neutralizes spreadsheet formulas', async () => {
  const t = setup(async url => {
    const params = new URL(url, 'https://example.test').searchParams;
    if (params.get('limit') !== '100') return page();
    if (!params.has('cursor')) return page([{ ...event, eventId: '=2+2,"quoted"' }], 'empty-page');
    if (params.get('cursor') === 'empty-page') return page([], 'last-page');
    return page([{ ...event, eventId: 'last-event' }]);
  });
  try {
    await t.ready(); t.$('exportLogs').click(); await until(() => t.downloads.length === 1);
    const csv = await t.blobs[0].text();
    assert.match(csv, /"'=2\+2,""quoted"""/); assert.match(csv, /last-event/);
    assert.match(csv, /2026-10-03T01:02:03.000Z/); assert.match(t.$('exportMessage').textContent, /2 baris/);
    assert.equal(t.calls.filter(call => new URL(call.url, 'https://example.test').searchParams.get('limit') === '100').length, 3);
  } finally { t.dom.window.close(); }
});

test('CSV failure and cancellation never download a partial file', async () => {
  let cancel = false;
  const t = setup(async (url, options) => {
    const params = new URL(url, 'https://example.test').searchParams;
    if (params.get('limit') !== '100') return page();
    if (cancel) return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError'))));
    return params.has('cursor') ? Response.json({}, { status: 503 }) : page([event], 'fails');
  });
  try {
    await t.ready(); t.$('exportLogs').click(); await until(() => !t.$('exportLogs').disabled);
    assert.equal(t.downloads.length, 0); assert.match(t.$('exportMessage').textContent, /File parsial tidak diunduh/);
    cancel = true; t.$('exportLogs').click(); t.$('cancelExport').click(); await until(() => !t.$('exportLogs').disabled);
    assert.equal(t.downloads.length, 0); assert.equal(t.$('exportMessage').textContent, 'Ekspor dibatalkan.');
  } finally { t.dom.window.close(); }
});

test('CSV limit refuses truncation rather than downloading partial results', async () => {
  let exports = 0;
  const t = setup(async url => {
    if (new URL(url, 'https://example.test').searchParams.get('limit') !== '100') return page();
    exports++;
    return page(Array.from({ length: 100 }, (_, i) => ({ ...event, eventId: `page-${exports}-${i}` })), `cursor-${exports}`);
  });
  try {
    await t.ready(); t.$('exportLogs').click(); await until(() => !t.$('exportLogs').disabled);
    assert.equal(t.downloads.length, 0); assert.match(t.$('exportMessage').textContent, /melebihi 10.000/);
  } finally { t.dom.window.close(); }
});

test('aborted requests cannot overwrite a newer filter result', async () => {
  let resolveFirst;
  const t = setup((url, options, count) => count === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve(page([{ ...event, deviceId: 'server-02' }])));
  try {
    t.$('logDevice').value = 'server-02'; t.submit(); await t.ready();
    resolveFirst(page()); await new Promise(setImmediate);
    assert.match(t.$('historyRows').textContent, /server-02/); assert.doesNotMatch(t.$('historyRows').textContent, /server-01/);
  } finally { t.dom.window.close(); }
});
