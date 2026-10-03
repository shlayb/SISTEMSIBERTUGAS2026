import { DAY_MS, HttpError, ID_PATTERN, MAX_BODY_BYTES, STATUSES } from './log-config.js';

export async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw new HttpError(415, 'Gunakan Content-Type application/json.');
  if (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity') throw new HttpError(415, 'Kompresi payload tidak didukung.');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new HttpError(413, 'Payload maksimal 16 KiB.');
  if (!request.body) throw new HttpError(400, 'Objek JSON diperlukan.');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  let expired = false;
  const timer = setTimeout(() => { expired = true; reader.cancel().catch(() => {}); }, 5000);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (expired) throw new HttpError(408, 'Waktu pembacaan payload habis.');
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { reader.cancel().catch(() => {}); throw new HttpError(413, 'Payload maksimal 16 KiB.'); }
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new HttpError(400, 'JSON tidak valid.'); }
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

function onlyFields(object, fields) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new HttpError(400, 'Objek JSON diperlukan.');
  if (Object.keys(object).some(key => !fields.includes(key))) throw new HttpError(400, 'Payload berisi field yang tidak diizinkan. Jangan kirim kredensial atau metadata tambahan.');
}

export function utcTimestamp(value, field = 'occurredAt') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw new HttpError(400, `${field} harus ISO 8601 UTC, diakhiri Z.`);
  const ts = Date.parse(value);
  const normalized = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (!Number.isFinite(ts) || new Date(ts).toISOString() !== normalized) throw new HttpError(400, `${field} tidak valid.`);
  return ts;
}

export function validateEvent(raw, source, now, retentionDays) {
  onlyFields(raw, ['eventId', 'deviceId', 'occurredAt', 'ts', 'temperature', 'humidity', 'smoke', 'setpoint', 'status', 'actuators', 'eventType', 'source', 'replay']);
  for (const key of ['eventId', 'deviceId']) if (typeof raw[key] !== 'string' || !ID_PATTERN.test(raw[key])) throw new HttpError(400, `${key} harus 1–96 karakter: huruf/angka, titik, garis bawah, atau tanda hubung; diawali huruf/angka.`);
  if (!source.devices.includes(raw.deviceId) || (raw.source !== undefined && raw.source !== source.source)) throw new HttpError(403, 'Sumber tidak diizinkan menulis perangkat atau jenis data ini.');
  if ((raw.occurredAt === undefined) === (raw.ts === undefined)) throw new HttpError(400, 'Kirim tepat satu waktu: occurredAt UTC atau ts epoch milidetik.');
  const ts = raw.occurredAt !== undefined ? utcTimestamp(raw.occurredAt) : raw.ts;
  if (!Number.isSafeInteger(ts) || ts < 1577836800000 || ts > now + 60000) throw new HttpError(400, 'Waktu kejadian tidak valid; sinkronkan jam perangkat dengan NTP.');
  if (ts <= now - retentionDays * DAY_MS) throw new HttpError(410, 'Kejadian sudah di luar masa retensi; timestamp asli tidak boleh diubah.');
  for (const [key, min, max] of [['temperature', -40, 80], ['humidity', 0, 100], ['smoke', 0, 100000], ['setpoint', 0, 80]]) {
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || raw[key] < min || raw[key] > max) throw new HttpError(400, `Nilai ${key} tidak valid.`);
  }
  if (!STATUSES.includes(raw.status)) throw new HttpError(400, 'Status harus NORMAL, WARNING, atau CRITICAL.');
  if (!['TELEMETRY', 'STATE_CHANGE', 'DEVICE_BOOT', 'BUFFER_SYNC'].includes(raw.eventType)) throw new HttpError(400, 'Jenis event tidak valid.');
  onlyFields(raw.actuators, ['servo', 'buzzer', 'led']);
  const { servo, buzzer, led } = raw.actuators;
  if (typeof servo !== 'number' || !Number.isFinite(servo) || servo < 0 || servo > 180 || typeof buzzer !== 'boolean' || !['green', 'yellow', 'red', 'off'].includes(led)) throw new HttpError(400, 'Posisi servo, status buzzer, atau LED tidak valid.');
  if (raw.replay !== undefined && typeof raw.replay !== 'boolean') throw new HttpError(400, 'replay harus boolean.');
  // Explicit allowlist: never spread an incoming payload into the database.
  return {
    eventId: raw.eventId, deviceId: raw.deviceId, source: source.source,
    occurredAt: new Date(ts).toISOString(), receivedAt: new Date(now).toISOString(),
    temperature: raw.temperature, humidity: raw.humidity, smoke: raw.smoke, setpoint: raw.setpoint,
    status: raw.status, servo, buzzer, led, eventType: raw.eventType, replay: raw.replay === true
  };
}
