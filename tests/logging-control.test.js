import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createLoggingHandler } from '../api/logging.js';

const controlKey = 'test-only-operator-key-at-least-32-characters';
const env = { LOG_CURSOR_SECRET: 'test-only-cursor-secret-at-least-32-characters', LOG_CONTROL_KEY: controlKey };
const stopped = { ok: true, enabled: false, changedAt: null, revision: 'initial', requiresKey: true };
const running = { ...stopped, enabled: true, changedAt: '2026-10-03T09:00:00.000Z', revision: 'started' };

test('logging status is public, but Start/Stop requires a separate operator key and same origin', async () => {
  const calls = [];
  const redisFactory = () => ({ command: async args => {
    calls.push(args);
    if (args[0] === 'GET') return null;
    if (args[1].includes("redis.call('INCR'")) return [1, 60000];
    return args.at(-1);
  } });
  const handler = createLoggingHandler({ env, redisFactory });
  assert.deepEqual(await (await handler(new Request('https://example.test/api/logging'))).json(), stopped);
  assert.equal(calls[0][0], 'GET');
  const post = (action, headers = {}) => new Request('https://example.test/api/logging', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${controlKey}`, Origin: 'https://example.test', ...headers }, body: JSON.stringify({ action }) });
  for (const action of ['start', 'stop']) {
    const response = await handler(post(action));
    assert.equal(response.status, 200); assert.equal((await response.json()).enabled, action === 'start');
  }
  const count = calls.length;
  assert.equal((await handler(post('start', { Authorization: 'Bearer wrong' }))).status, 401);
  assert.equal((await handler(post('stop', { Origin: 'https://other.test' }))).status, 403);
  assert.equal((await handler(post('stop', { 'Sec-Fetch-Site': 'cross-site' }))).status, 403);
  assert.equal(calls.length, count);
  assert.equal((await handler(post('delete'))).status, 400);
  assert.equal((await handler(new Request('https://example.test/api/logging', { method: 'DELETE' }))).status, 405);
  const unconfigured = createLoggingHandler({ env: { LOG_CURSOR_SECRET: env.LOG_CURSOR_SECRET }, redisFactory });
  assert.equal((await unconfigured(post('start'))).status, 503);
  const failed = createLoggingHandler({ env, redisFactory: () => ({ command: async () => { throw new Error(controlKey); } }) });
  const failure = await failed(new Request('https://example.test/api/logging'));
  assert.equal(failure.status, 503); assert.doesNotMatch(await failure.text(), /test-only-operator/);
});

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../assets/js/logging-control.js', import.meta.url), 'utf8');
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(setImmediate); }
  assert.fail('Logging UI did not settle');
}
function setup(fetchImpl) {
  const dom = new JSDOM(html, { url: 'https://example.test/index.html', runScripts: 'outside-only' });
  const { window } = dom, calls = [], polls = [], timers = new Map();
  let timerId = 0;
  window.fetch = async (url, options) => { calls.push({ url, options }); return fetchImpl(url, options, calls.length); };
  window.setInterval = fn => { polls.push(fn); return polls.length; }; window.clearInterval = () => {};
  window.setTimeout = (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; }; window.clearTimeout = id => timers.delete(id);
  Object.defineProperty(window.document, 'hidden', { value: false, configurable: true });
  const $ = id => window.document.getElementById(id);
  const dialog = $('loggingControlDialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new window.Event('close')); };
  window.eval(script);
  const ready = () => until(() => !$('toggleLogging').disabled);
  const submit = () => { $('loggingControlKey').value = controlKey; $('loggingControlForm').dispatchEvent(new window.Event('submit', { cancelable: true })); };
  return { dom, window, $, calls, polls, timers, ready, submit };
}

test('Start/Stop sits left of MQTT, changes only after confirmation, and does not persist operator keys', async () => {
  let resolvePost;
  const t = setup(async (url, options) => options.method === 'POST' ? new Promise(resolve => { resolvePost = resolve; }) : Response.json(stopped));
  try {
    await t.ready();
    const controls = [...t.$('toggleLogging').parentElement.children];
    assert.equal(controls[0].id, 'toggleLogging'); assert.equal(controls[1].id, 'connectionBadge');
    assert.equal(t.$('loggingControlLabel').textContent, 'Start Logging');
    t.$('toggleLogging').click(); t.submit();
    assert.equal(t.$('toggleLogging').disabled, true); assert.equal(t.$('toggleLogging').dataset.enabled, 'false');
    t.$('toggleLogging').dispatchEvent(new t.window.Event('click'));
    assert.equal(t.calls.filter(call => call.options.method === 'POST').length, 1);
    assert.deepEqual(JSON.parse(t.calls[1].options.body), { action: 'start' });
    assert.equal(t.$('loggingControlKey').value, ''); assert.equal(t.window.localStorage.length, 0); assert.equal(t.window.sessionStorage.length, 0);
    resolvePost(Response.json(running)); await t.ready();
    assert.equal(t.$('loggingControlLabel').textContent, 'Stop Logging'); assert.equal(t.$('toggleLogging').dataset.enabled, 'true');
    t.$('toggleLogging').click(); t.submit();
    assert.deepEqual(JSON.parse(t.calls[2].options.body), { action: 'stop' });
    resolvePost(Response.json(stopped)); await t.ready();
    assert.equal(t.$('loggingControlLabel').textContent, 'Start Logging');
    assert.ok(t.calls.every(call => call.url === '/api/logging'));
  } finally { t.dom.window.close(); }
});

test('other-device status is refreshed; cancellation and failure cannot fake an active logger', async () => {
  let latest = stopped;
  const t = setup(async (url, options) => options.method === 'POST' ? Response.json({}, { status: 401 }) : Response.json(latest));
  try {
    await t.ready(); t.$('toggleLogging').click(); t.$('loggingControlKey').value = controlKey; t.$('cancelLoggingControl').click();
    assert.equal(t.calls.length, 1); assert.equal(t.$('loggingControlKey').value, '');
    latest = running; t.polls[0](); await t.ready(); assert.equal(t.$('loggingControlLabel').textContent, 'Stop Logging');
    t.$('toggleLogging').click(); t.submit(); await t.ready();
    assert.equal(t.$('loggingControlLabel').textContent, 'Coba lagi'); assert.match(t.$('loggingControlStatus').textContent, /Kunci operator salah/);
    t.$('toggleLogging').click(); await t.ready(); assert.equal(t.calls.at(-1).options.method, undefined); assert.equal(t.$('loggingControlLabel').textContent, 'Stop Logging');
  } finally { t.dom.window.close(); }
});

test('timeout triggers a status recheck rather than repeating a possibly applied Start request', async () => {
  const t = setup(async (url, options) => options.method === 'POST' ? new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))) : Response.json(stopped));
  try {
    await t.ready(); t.$('toggleLogging').click(); t.submit();
    const timeout = [...t.timers.values()][0]; assert.equal(timeout.delay, 10000); timeout.fn(); await t.ready();
    assert.match(t.$('loggingControlStatus').textContent, /Waktu konfirmasi/); assert.equal(t.$('loggingControlLabel').textContent, 'Coba lagi');
    t.$('toggleLogging').click(); await t.ready(); assert.equal(t.calls.filter(call => call.options.method === 'POST').length, 1);
  } finally { t.dom.window.close(); }
});
