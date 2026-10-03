import { createHmac } from 'node:crypto';
import { DAY_MS, digest, HttpError, ID_PATTERN, MAX_PAGE_SIZE, MAX_SCAN, secretsEqual, STATUSES } from './log-config.js';
import { utcTimestamp } from './log-validation.js';
import { loggingControlKey } from './logging-control.js';

export const RATE_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], 60000) end
return {count, redis.call('PTTL', KEYS[1])}
`;

// All writes, including the deduplication decision and every index, are atomic.
export const INGEST_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then return {0, existing} end
local control = redis.call('GET', KEYS[3])
if not control or cjson.decode(control).enabled ~= true then return {2, ''} end
local clock = redis.call('TIME')
if tonumber(ARGV[2]) <= tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000) then return {-1, ''} end
local event = cjson.decode(ARGV[1])
event._sequence = redis.call('INCR', KEYS[2])
local encoded = cjson.encode(event)
redis.call('SET', KEYS[1], encoded, 'PXAT', ARGV[2])
for i = 4, #KEYS do
  redis.call('ZADD', KEYS[i], 0, ARGV[3])
  redis.call('PEXPIREAT', KEYS[i], ARGV[4])
end
return {1, encoded}
`;

// Equal scores are intentional: timestamp:hash gives stable time + tie ordering.
// Daily indexes expire without a cron job or writes from the public read endpoint.
export const READ_INDEX_SCRIPT = `
local snapshot = ARGV[1]
if snapshot == '' then snapshot = redis.call('GET', KEYS[1]) or '0' end
local output = {snapshot}
local remaining = tonumber(ARGV[4])
for i = 2, #KEYS do
  local members = redis.call('ZREVRANGEBYLEX', KEYS[i], ARGV[2], ARGV[3], 'LIMIT', 0, remaining)
  for _, member in ipairs(members) do table.insert(output, member) end
  remaining = remaining - #members
  if remaining == 0 then break end
end
return output
`;

const sequenceKey = config => `${config.prefix}:sequence`;
const eventKey = (config, source, hash) => `${config.prefix}:${source}:event:${hash}`;
const dayLabel = ts => new Date(ts).toISOString().slice(0, 10);
const stamp = ts => String(ts).padStart(13, '0');
function indexKey(config, source, day, device = '', status = '') {
  return `${config.prefix}:${source}:time:${day}:${device || '*'}:${status || '*'}`;
}

export async function enforceIngestRate(redis, config, sourceId) {
  const result = await redis.command(['EVAL', RATE_SCRIPT, 1, `${config.prefix}:rate:${digest(sourceId)}`, config.ingestPerMinute]);
  if (!Array.isArray(result) || result.length !== 2) throw new Error('Invalid rate response');
  if (Number(result[0]) > config.ingestPerMinute) throw new HttpError(429, 'Batas ingest tercapai. Coba kembali setelah jeda.', { 'Retry-After': String(Math.max(1, Math.ceil(Number(result[1]) / 1000))) });
}

export async function insertEvent(redis, config, event) {
  const ts = Date.parse(event.occurredAt);
  const hash = digest(`${event.deviceId}\0${event.eventId}`);
  const day = dayLabel(ts);
  const keys = [eventKey(config, event.source, hash), sequenceKey(config), loggingControlKey(config),
    indexKey(config, event.source, day), indexKey(config, event.source, day, event.deviceId),
    indexKey(config, event.source, day, '', event.status), indexKey(config, event.source, day, event.deviceId, event.status)];
  const expiresAt = ts + config.retentionDays * DAY_MS;
  const indexExpiresAt = (Math.floor(ts / DAY_MS) + 1) * DAY_MS + config.retentionDays * DAY_MS;
  const result = await redis.command(['EVAL', INGEST_SCRIPT, keys.length, ...keys,
    JSON.stringify(event), expiresAt, `${stamp(ts)}:${hash}`, indexExpiresAt]);
  if (Array.isArray(result) && result[0] === -1) throw new HttpError(410, 'Kejadian sudah di luar masa retensi; timestamp asli tidak boleh diubah.');
  if (Array.isArray(result) && result[0] === 2) return { skipped: true, reason: 'logging_stopped', eventId: event.eventId, deviceId: event.deviceId };
  if (!Array.isArray(result) || ![0, 1].includes(result[0]) || typeof result[1] !== 'string') throw new Error('Invalid ingest response');
  const saved = JSON.parse(result[1]);
  return { duplicate: result[0] === 0, eventId: saved.eventId, deviceId: saved.deviceId, receivedAt: saved.receivedAt };
}

const sign = (payload, secret) => createHmac('sha256', secret).update(payload).digest('base64url');
export function encodeCursor(value, secret) {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}
function decodeCursor(cursor, secret) {
  if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw new HttpError(400, 'Cursor tidak valid.');
  const [payload, signature] = cursor.split('.');
  if (!secretsEqual(signature, sign(payload, secret))) throw new HttpError(400, 'Cursor tidak valid.');
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { throw new HttpError(400, 'Cursor tidak valid.'); }
}

export function parseLogQuery(url, config, now) {
  const params = new URL(url).searchParams;
  const allowed = ['source', 'deviceId', 'status', 'from', 'to', 'limit', 'cursor'];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new HttpError(400, 'Parameter filter tidak valid.');
  const filters = { source: params.get('source') || 'device', deviceId: params.get('deviceId') || '', status: params.get('status') || '', from: params.get('from') || '', to: params.get('to') || '' };
  if (!['device', 'simulation'].includes(filters.source) || (filters.deviceId && !ID_PATTERN.test(filters.deviceId)) || (filters.status && !STATUSES.includes(filters.status))) throw new HttpError(400, 'Filter perangkat, sumber, atau status tidak valid.');
  const limitText = params.get('limit') || '25';
  if (!/^\d{1,3}$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > MAX_PAGE_SIZE) throw new HttpError(400, 'Jumlah hasil harus 1–100.');
  const requestedFrom = filters.from ? utcTimestamp(filters.from, 'from') : null;
  const requestedTo = filters.to ? utcTimestamp(filters.to, 'to') : null;
  if (requestedFrom !== null && requestedTo !== null && requestedFrom > requestedTo) throw new HttpError(400, 'Waktu awal harus sebelum atau sama dengan waktu akhir.');
  const filterHash = digest(JSON.stringify(filters));
  let state = { v: 1, filterHash, from: requestedFrom ?? now - config.retentionDays * DAY_MS, to: requestedTo ?? now, createdAt: now, retentionDays: config.retentionDays, snapshot: null, before: '' };
  if (params.has('cursor')) {
    state = decodeCursor(params.get('cursor'), config.cursorSecret);
    if (!state || state.v !== 1 || state.filterHash !== filterHash || !Number.isSafeInteger(state.from) || !Number.isSafeInteger(state.to) || !Number.isSafeInteger(state.createdAt) || !Number.isSafeInteger(state.snapshot) || state.snapshot < 0 || !/^\d{13}:[a-f0-9]{64}$/.test(state.before)) throw new HttpError(400, 'Cursor tidak cocok dengan filter.');
    if (now - state.createdAt > 15 * 60000 || state.createdAt > now || state.retentionDays !== config.retentionDays) throw new HttpError(410, 'Cursor kedaluwarsa. Muat ulang halaman pertama.');
  }
  return { filters, limit: Number(limitText), state, from: Math.max(state.from, now - config.retentionDays * DAY_MS + 1), to: Math.min(state.to, now + 60000) };
}

// Return only public schema fields, even if a database record was manually changed.
function publicEvent(event) {
  const fields = ['eventId', 'deviceId', 'source', 'occurredAt', 'receivedAt', 'temperature', 'humidity', 'smoke', 'setpoint', 'status', 'servo', 'buzzer', 'led', 'eventType', 'replay'];
  return Object.fromEntries(fields.map(key => [key, event[key]]));
}

export async function readEvents(redis, config, query) {
  const { filters, limit, state, from, to } = query;
  const response = { items: [], nextCursor: null, snapshotAt: new Date(state.createdAt).toISOString(), retentionDays: config.retentionDays };
  if (from > to) return response;
  const keys = [sequenceKey(config)];
  for (let day = Math.floor(to / DAY_MS); day >= Math.floor(from / DAY_MS); day--) keys.push(indexKey(config, filters.source, dayLabel(day * DAY_MS), filters.deviceId, filters.status));
  const upper = state.before ? `(${state.before}` : `[${stamp(to)}:~`;
  const result = await redis.command(['EVAL_RO', READ_INDEX_SCRIPT, keys.length, ...keys, state.snapshot ?? '', upper, `[${stamp(from)}:`, MAX_SCAN + 1]);
  if (!Array.isArray(result) || !Number.isSafeInteger(Number(result[0])) || Number(result[0]) < 0) throw new Error('Invalid index response');
  const snapshot = Number(result[0]);
  const candidates = result.slice(1, MAX_SCAN + 1);
  if (!candidates.every(member => typeof member === 'string' && /^\d{13}:[a-f0-9]{64}$/.test(member))) throw new Error('Invalid index member');
  if (!candidates.length) return response;
  const records = await redis.command(['MGET', ...candidates.map(member => eventKey(config, filters.source, member.slice(14)))]);
  if (!Array.isArray(records) || records.length !== candidates.length) throw new Error('Invalid record response');
  let before = state.before;
  let more = result.length > MAX_SCAN + 1;
  for (let i = 0; i < records.length; i++) {
    const event = records[i] === null ? null : JSON.parse(records[i]);
    if (event && Number.isSafeInteger(event._sequence) && event._sequence <= snapshot) {
      if (response.items.length === limit) { more = true; break; }
      response.items.push(publicEvent(event));
    }
    before = candidates[i];
  }
  if (more) response.nextCursor = encodeCursor({ ...state, snapshot, before }, config.cursorSecret);
  return response;
}
