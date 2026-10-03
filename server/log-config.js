import { createHash, timingSafeEqual } from 'node:crypto';

export const DAY_MS = 86400000;
export const MAX_BODY_BYTES = 16384;
export const MAX_PAGE_SIZE = 100;
export const MAX_SCAN = 500;
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
export const STATUSES = ['NORMAL', 'WARNING', 'CRITICAL'];

export class HttpError extends Error {
  constructor(status, message, headers = {}) { super(message); this.status = status; this.headers = headers; }
}

function integerSetting(env, name, fallback, min, max) {
  const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw new HttpError(503, 'Konfigurasi layanan log belum valid.');
  return value;
}

export function logConfig(env = process.env) {
  const cursorSecret = env.LOG_CURSOR_SECRET || '';
  if (cursorSecret.length < 32) throw new HttpError(503, 'Layanan log belum dikonfigurasi.');
  return {
    prefix: 'thermoguard:logs:v1', cursorSecret,
    retentionDays: integerSetting(env, 'LOG_RETENTION_DAYS', 7, 1, 90),
    ingestPerMinute: integerSetting(env, 'INGEST_RATE_LIMIT_PER_MINUTE', 120, 1, 10000)
  };
}

export const digest = value => createHash('sha256').update(value).digest('hex');
export function secretsEqual(a, b) {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

export function authenticateSource(request, env = process.env) {
  let sources;
  try { sources = JSON.parse(env.INGEST_SOURCES || ''); }
  catch { throw new HttpError(503, 'Sumber ingest belum dikonfigurasi.'); }
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) throw new HttpError(503, 'Sumber ingest belum dikonfigurasi.');
  const id = request.headers.get('x-ingest-source') || '';
  const authorization = request.headers.get('authorization') || '';
  const token = /^Bearer ([^\s]{32,256})$/.exec(authorization)?.[1] || '';
  const source = Object.hasOwn(sources, id) ? sources[id] : null;
  if (source && (typeof source.token !== 'string' || source.token.length < 32 || source.token.length > 256 || /^REPLACE_|^YOUR_/.test(source.token))) throw new HttpError(503, 'Ganti placeholder dengan rahasia sumber yang valid.');
  if (!ID_PATTERN.test(id) || !source || typeof source.token !== 'string' || source.token.length < 32 || !token || !secretsEqual(token, source.token)) {
    throw new HttpError(401, 'Autentikasi sumber ditolak.', { 'WWW-Authenticate': 'Bearer' });
  }
  if (!['device', 'simulation'].includes(source.source) || !Array.isArray(source.devices) || !source.devices.length || !source.devices.every(device => typeof device === 'string' && ID_PATTERN.test(device))) {
    throw new HttpError(503, 'Konfigurasi sumber ingest belum valid.');
  }
  return { id, source: source.source, devices: source.devices };
}

export function jsonResponse(data, status = 200, extraHeaders = {}) {
  return Response.json(data, { status, headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders
  } });
}

export function errorResponse(error) {
  if (error instanceof HttpError) return jsonResponse({ error: error.message }, error.status, error.headers);
  // Do not log payloads, Authorization headers, database URLs, or upstream errors.
  return jsonResponse({ error: 'Database log tidak tersedia. Coba kembali nanti.' }, 503, { 'Retry-After': '10' });
}
