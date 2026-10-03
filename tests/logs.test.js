import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authenticateSource, DAY_MS, logConfig, MAX_BODY_BYTES } from '../server/log-config.js';
import { readJson, utcTimestamp, validateEvent } from '../server/log-validation.js';
import { encodeCursor, parseLogQuery } from '../server/log-store.js';
import { createRedis } from '../server/redis-rest.js';
import { createIngestHandler } from '../api/ingest.js';
import { createLogsHandler } from '../api/logs.js';

export const secret = 'test-only-ingest-key-not-for-production-12345';
export const env = {
  LOG_CURSOR_SECRET: 'test-only-cursor-key-not-for-production-12345',
  INGEST_SOURCES: JSON.stringify({ test: { token: secret, devices: ['server-01', 'server-02'], source: 'device' }, demo: { token: secret, devices: ['demo-01'], source: 'simulation' } })
};
export const source = { id: 'test', devices: ['server-01', 'server-02'], source: 'device' };
export function payload(now = Date.now(), override = {}) {
  return { eventId: 'boot-a-1', deviceId: 'server-01', ts: now - 1000, temperature: 27, humidity: 48, smoke: 75, setpoint: 30, status: 'NORMAL', actuators: { servo: 0, buzzer: false, led: 'green' }, eventType: 'TELEMETRY', ...override };
}
export function ingestRequest(body, options = {}) {
  return new Request('https://example.test/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}`, 'X-Ingest-Source': 'test', ...options.headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

test('timestamps are strict UTC, retain original time, and receive server time', () => {
  const now = Date.now();
  const event = validateEvent(payload(now, { ts: now - 2 * DAY_MS, replay: true }), source, now, 7);
  assert.equal(event.occurredAt, new Date(now - 2 * DAY_MS).toISOString());
  assert.equal(event.receivedAt, new Date(now).toISOString());
  assert.equal(event.replay, true);
  assert.equal(utcTimestamp('2026-10-03T01:02:03Z'), Date.parse('2026-10-03T01:02:03.000Z'));
  for (const value of ['2026-02-30T00:00:00Z', '2026-10-03T00:00:00+07:00', '2026-10-03', 'bad']) assert.throws(() => utcTimestamp(value));
});

test('rejects invalid schema, secrets, impossible numbers, stale/future timestamps', () => {
  const now = Date.now();
  for (const change of [
    { temperature: '27' }, { humidity: 101 }, { smoke: -1 }, { temperature: Infinity }, { setpoint: 81 },
    { status: 'OTHER' }, { eventId: '=formula' }, { deviceId: '' }, { eventType: 'token=secret' },
    { telegramToken: 'secret' }, { credentials: {} }, { actuators: { servo: 0, buzzer: false, led: 'green', token: 'secret' } },
    { actuators: { servo: 181, buzzer: false, led: 'green' } }, { actuators: null }, { replay: 'true' },
    { ts: now + 61000 }, { ts: now - 8 * DAY_MS }, { ts: undefined }, { occurredAt: new Date(now).toISOString() }
  ]) assert.throws(() => validateEvent(payload(now, change), source, now, 7));
  assert.throws(() => validateEvent([], source, now, 7));
});

test('source credentials and device/simulation scopes fail closed', () => {
  assert.equal(authenticateSource(ingestRequest(payload()), env).id, 'test');
  for (const headers of [{ Authorization: 'Bearer wrong' }, { 'X-Ingest-Source': 'missing' }, { 'X-Ingest-Source': '__proto__' }]) assert.throws(() => authenticateSource(ingestRequest(payload(), { headers }), env));
  assert.throws(() => authenticateSource(ingestRequest(payload()), {}));
  for (const change of [{ deviceId: 'unapproved-device' }, { source: 'simulation' }]) assert.throws(() => validateEvent(payload(Date.now(), change), source, Date.now(), 7), error => error.status === 403);
});

test('body limits apply to declared size, chunked bytes, JSON and content type', async () => {
  assert.equal((await readJson(ingestRequest(payload()))).deviceId, 'server-01');
  await assert.rejects(readJson(ingestRequest('{}', { headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) } })), error => error.status === 413);
  await assert.rejects(readJson(ingestRequest(' '.repeat(MAX_BODY_BYTES) + '{}')), error => error.status === 413);
  await assert.rejects(readJson(ingestRequest('{bad')), error => error.status === 400);
  await assert.rejects(readJson(ingestRequest('{}', { headers: { 'Content-Type': 'text/plain' } })), error => error.status === 415);
  await assert.rejects(readJson(ingestRequest('{}', { headers: { 'Content-Encoding': 'gzip' } })), error => error.status === 415);
  const chunks = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_BODY_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close(); } });
  const request = new Request('https://example.test', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '1' }, body: chunks, duplex: 'half' });
  await assert.rejects(readJson(request), error => error.status === 413);
});

test('query validates bounds, limits, signed cursors, and expiration', () => {
  const config = logConfig(env), now = Date.now();
  const query = parseLogQuery('https://example.test/api/logs?status=NORMAL', config, now);
  const cursorState = { ...query.state, snapshot: 2, before: `${now - 1000}:${'a'.repeat(64)}` };
  const cursor = encodeCursor(cursorState, config.cursorSecret);
  const next = `https://example.test/api/logs?status=NORMAL&cursor=${cursor}`;
  assert.equal(parseLogQuery(next, config, now + 1000).state.snapshot, 2);
  assert.throws(() => parseLogQuery(next.replace('status=NORMAL', 'status=CRITICAL'), config, now));
  assert.throws(() => parseLogQuery(next, config, now + 16 * 60000), error => error.status === 410);
  for (const search of ['limit=101', 'limit=0', 'limit=1&limit=2', 'source=all', 'deviceId=*', 'status=bad', 'delete=true', 'cursor=invalid', 'from=2026-10-04T00:00:00Z&to=2026-10-03T00:00:00Z']) assert.throws(() => parseLogQuery(`https://example.test/api/logs?${search}`, config, now));
});

test('HTTP routes disallow other methods and hide all upstream error details', async () => {
  const failing = () => ({ command: async () => { throw new Error('SECRET redis://password@example.test'); } });
  const ingest = createIngestHandler({ env, redisFactory: failing });
  const logs = createLogsHandler({ env, redisFactory: failing });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) assert.equal((await logs(new Request('https://example.test/api/logs', { method }))).status, 405);
  assert.equal((await ingest(new Request('https://example.test/api/ingest'))).status, 405);
  for (const response of [await ingest(ingestRequest(payload())), await logs(new Request('https://example.test/api/logs'))]) {
    assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.doesNotMatch(await response.text(), /SECRET|password/);
  }
  const unauthorized = await ingest(new Request('https://example.test/api/ingest', { method: 'POST' }));
  assert.equal(unauthorized.status, 401);
});

test('Redis REST sends secrets only in server headers and never retries', async () => {
  const calls = [];
  const config = { UPSTASH_REDIS_REST_URL: 'https://redis.example.test', UPSTASH_REDIS_REST_TOKEN: 'server-secret' };
  const redis = createRedis(config, async (url, options) => { calls.push({ url, options }); return Response.json({ result: 'OK' }); });
  assert.equal(await redis.command(['GET', 'key']), 'OK');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer server-secret');
  assert.equal(calls[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0].options.body), ['GET', 'key']);
  let attempts = 0;
  await assert.rejects(createRedis(config, async () => { attempts++; throw new Error('offline'); }).command(['GET', 'key']));
  assert.equal(attempts, 1);
  assert.throws(() => createRedis({ ...config, UPSTASH_REDIS_REST_URL: 'http://redis.example.test' }));
  assert.throws(() => createRedis({}));
});
