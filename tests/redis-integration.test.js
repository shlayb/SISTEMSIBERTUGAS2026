import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { DAY_MS, digest, logConfig } from '../server/log-config.js';
import { enforceIngestRate, insertEvent, parseLogQuery, readEvents } from '../server/log-store.js';
import { validateEvent } from '../server/log-validation.js';
import { createIngestHandler } from '../api/ingest.js';
import { createLogsHandler } from '../api/logs.js';
import { getLoggingState, setLoggingState } from '../server/logging-control.js';

// Explicitly opt in to a disposable local Redis. No FLUSHDB/FLUSHALL is used.
test('real Redis: concurrent deduplication, indexes, cursor ties, replay, retention, read-only queries, and rate limits', { skip: !process.env.LOG_TEST_REDIS_URL }, async () => {
  const client = new Redis(process.env.LOG_TEST_REDIS_URL, { maxRetriesPerRequest: 0, retryStrategy: () => null });
  const calls = [];
  const redis = { command: async args => { calls.push(args); return client.call(...args); } };
  const config = { ...logConfig({ LOG_CURSOR_SECRET: 'test-only-cursor-secret-at-least-32-chars' }), prefix: `thermoguard:test:${randomUUID()}` };
  const now = Date.now();
  const source = { source: 'device', devices: ['server-01', 'server-02'] };
  const event = (eventId, ts = now - 1000, changes = {}) => validateEvent({ eventId, deviceId: 'server-01', ts, temperature: 27, humidity: 45, smoke: 75, setpoint: 30, status: 'NORMAL', actuators: { servo: 0, buzzer: false, led: 'green' }, eventType: 'TELEMETRY', ...changes }, source, now, config.retentionDays);
  const read = (query = '', at = now) => readEvents(redis, config, parseLogQuery(`https://example.test/api/logs?${query}`, config, at));
  try {
    assert.equal((await getLoggingState(redis, config)).enabled, false);
    assert.equal((await insertEvent(redis, config, event('initially-stopped'))).skipped, true);
    assert.equal((await read()).items.length, 0);
    await setLoggingState(redis, config, true);
    const outcomes = await Promise.all(Array.from({ length: 20 }, () => insertEvent(redis, config, event('same-event'))));
    assert.equal(outcomes.filter(result => !result.duplicate).length, 1);
    assert.equal(new Set(outcomes.map(result => result.receivedAt)).size, 1);
    await insertEvent(redis, config, event('same-event', now - 3000, { replay: true }));
    assert.equal((await read()).items[0].occurredAt, new Date(now - 1000).toISOString());
    // Distinct device IDs with an identical event ID remain separate.
    await insertEvent(redis, config, event('same-event', now - 1000, { deviceId: 'server-02', status: 'CRITICAL' }));
    for (let i = 0; i < 8; i++) await insertEvent(redis, config, event(`tie-${i}`));
    await insertEvent(redis, config, event('offline-buffer', now - 2 * DAY_MS, { replay: true, eventType: 'BUFFER_SYNC' }));
    await insertEvent(redis, config, { ...event('demo-event'), source: 'simulation' });
    const all = await read('limit=100');
    assert.equal(all.items.length, 11); assert.ok(all.items.every(item => item.source === 'device'));
    assert.equal((await read('source=simulation')).items.length, 1);
    assert.equal((await read('deviceId=server-02&status=CRITICAL')).items.length, 1);
    assert.equal((await read('deviceId=server-02&status=NORMAL')).items.length, 0);
    const page1 = await read('limit=3');
    // New arrivals, including backdated offline events, cannot shift a cursor snapshot.
    await insertEvent(redis, config, event('arrived-later', now - DAY_MS));
    let page = page1;
    const ids = page.items.map(item => `${item.deviceId}/${item.eventId}`);
    while (page.nextCursor) {
      page = await read(`limit=3&cursor=${encodeURIComponent(page.nextCursor)}`);
      ids.push(...page.items.map(item => `${item.deviceId}/${item.eventId}`));
    }
    assert.equal(ids.length, 11); assert.equal(new Set(ids).size, 11); assert.ok(!ids.includes('server-01/arrived-later'));
    const before = calls.length;
    await read('status=NORMAL');
    assert.deepEqual(calls.slice(before).map(call => call[0]), ['EVAL_RO', 'MGET']);
    const eventKey = `${config.prefix}:device:event:${digest('server-01\0offline-buffer')}`;
    const ttl = await client.pttl(eventKey);
    assert.ok(ttl > 4 * DAY_MS && ttl <= 5 * DAY_MS);
    const indexKeys = await client.keys(`${config.prefix}:device:time:*`);
    assert.ok(indexKeys.length > 0);
    assert.ok((await Promise.all(indexKeys.map(key => client.pttl(key)))).every(value => value > 0 && value <= 8 * DAY_MS));
    // A record missing between index lookup and read must not stall pagination.
    await client.del(eventKey);
    assert.equal((await read('limit=100')).items.some(item => item.eventId === 'offline-buffer'), false);
    // A record outside the current configured horizon is never returned.
    assert.equal((await read('limit=100', now + 8 * DAY_MS)).items.length, 0);
    const rateConfig = { ...config, ingestPerMinute: 2 };
    await enforceIngestRate(redis, rateConfig, 'source'); await enforceIngestRate(redis, rateConfig, 'source');
    await assert.rejects(enforceIngestRate(redis, rateConfig, 'source'), error => error.status === 429 && Number(error.headers['Retry-After']) > 0);
    assert.ok((await client.pttl(`${config.prefix}:rate:${digest('source')}`)) > 0);
    // Crossing retention while an HTTP request is in flight must not acknowledge an expired write.
    await assert.rejects(insertEvent(redis, config, { ...event('already-expired'), occurredAt: new Date(now - 8 * DAY_MS).toISOString() }), error => error.status === 410);
    // Public output uses an allowlist even if a record was edited outside the app.
    const extraKey = `${config.prefix}:device:event:${digest('server-01\0same-event')}`;
    const extraRecord = JSON.parse(await client.get(extraKey)); extraRecord.telegramToken = 'must-not-leak';
    await client.set(extraKey, JSON.stringify(extraRecord), 'KEEPTTL');
    assert.ok(!(await read('limit=100')).items.some(item => Object.hasOwn(item, 'telegramToken')));
    // Bound scans can produce an empty page; the cursor must still advance past new arrivals.
    const snapshotPage = await read('limit=1');
    await Promise.all(Array.from({ length: 1010 }, (_, i) => insertEvent(redis, config, event(`new-backfill-${i}`, now - 1500))));
    let cursor = snapshotPage.nextCursor;
    const collected = [...snapshotPage.items];
    let emptyPage = false, pages = 0;
    while (cursor) {
      const result = await read(`limit=1&cursor=${encodeURIComponent(cursor)}`);
      assert.ok(result.items.length <= 1); if (!result.items.length && result.nextCursor) emptyPage = true;
      collected.push(...result.items); cursor = result.nextCursor;
      assert.ok(++pages < 30);
    }
    assert.ok(emptyPage); assert.equal(collected.length, 11);
    assert.ok(collected.every(item => !item.eventId.startsWith('new-backfill-')));
    // Exercise both complete HTTP handlers against the real Redis, with isolated keys.
    const sourceToken = 'test-only-http-ingest-token-at-least-32-characters';
    const httpEnv = { LOG_CURSOR_SECRET: config.cursorSecret, INGEST_SOURCES: JSON.stringify({ http: { token: sourceToken, devices: ['server-http'], source: 'device' } }) };
    const redisFactory = () => ({ command: args => redis.command(args.map(value => typeof value === 'string' && value.startsWith('thermoguard:logs:v1') ? value.replace('thermoguard:logs:v1', config.prefix) : value)) });
    const ingestHandler = createIngestHandler({ env: httpEnv, redisFactory });
    const logsHandler = createLogsHandler({ env: httpEnv, redisFactory });
    const body = { eventId: 'http-event', deviceId: 'server-http', ts: Date.now() - 1000, temperature: 27, humidity: 45, smoke: 75, setpoint: 30, status: 'NORMAL', actuators: { servo: 0, buzzer: false, led: 'green' }, eventType: 'TELEMETRY' };
    const request = () => new Request('https://example.test/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sourceToken}`, 'X-Ingest-Source': 'http' }, body: JSON.stringify(body) });
    const accepted = await Promise.all([ingestHandler(request()), ingestHandler(request())]);
    assert.deepEqual(accepted.map(result => result.status).sort(), [200, 201]);
    const publicRequest = () => new Request('https://example.test/api/logs?deviceId=server-http');
    const [clientA, clientB] = await Promise.all([logsHandler(publicRequest()), logsHandler(publicRequest())]);
    const sharedA = await clientA.json(), sharedB = await clientB.json();
    assert.equal(sharedA.items.length, 1); assert.deepEqual(sharedA.items, sharedB.items);
    const denied = await logsHandler(new Request('https://example.test/api/logs?deviceId=server-http', { method: 'DELETE' }));
    assert.equal(denied.status, 405); assert.equal((await (await logsHandler(publicRequest())).json()).items.length, 1);
    // Stop and ingest are serialized by Redis: after Stop confirms, no new row can be written.
    const stoppedState = await setLoggingState(redis, config, false);
    assert.equal(stoppedState.enabled, false);
    assert.deepEqual(await getLoggingState(redis, config), stoppedState);
    assert.deepEqual(await setLoggingState(redis, config, false), stoppedState);
    const stoppedResults = await Promise.all(Array.from({ length: 20 }, (_, i) => insertEvent(redis, config, event(`stopped-${i}`))));
    assert.ok(stoppedResults.every(result => result.skipped && result.reason === 'logging_stopped'));
    const oldLogs = await read('deviceId=server-http'); assert.equal(oldLogs.items.length, 1);
    const pausedRequest = new Request('https://example.test/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sourceToken}`, 'X-Ingest-Source': 'http' }, body: JSON.stringify({ ...body, eventId: 'http-skipped' }) });
    const pausedResponse = await ingestHandler(pausedRequest); assert.equal(pausedResponse.status, 200);
    const pausedBody = await pausedResponse.json(); assert.equal(pausedBody.recorded, false); assert.equal(pausedBody.skipped, true);
    const restarted = await setLoggingState(redis, config, true);
    assert.notEqual(restarted.revision, stoppedState.revision);
    assert.equal((await insertEvent(redis, config, event('after-restart'))).duplicate, false);
  } finally {
    const keys = await client.keys(`${config.prefix}:*`);
    if (keys.length) await client.del(...keys);
    await client.quit();
  }
});
