import { errorResponse, HttpError, jsonResponse, logConfig, secretsEqual } from '../server/log-config.js';
import { createRedis } from '../server/redis-rest.js';
import { enforceIngestRate } from '../server/log-store.js';
import { getLoggingState, setLoggingState } from '../server/logging-control.js';
import { readJson } from '../server/log-validation.js';

export function createLoggingHandler({ env = process.env, clock = Date.now, redisFactory = createRedis } = {}) {
  return async request => {
    try {
      if (!['GET', 'POST'].includes(request.method)) throw new HttpError(405, 'Gunakan GET atau POST.', { Allow: 'GET, POST' });
      const config = logConfig(env);
      const redis = redisFactory(env);
      if (request.method === 'GET') return jsonResponse({ ok: true, ...await getLoggingState(redis, config), requiresKey: true });
      const origin = request.headers.get('origin');
      if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError(403, 'Kendali logging hanya tersedia dari situs ini.');
      const key = env.LOG_CONTROL_KEY || '';
      if (!/^[\x21-\x7e]{32,256}$/.test(key) || /^REPLACE_|^YOUR_/.test(key)) throw new HttpError(503, 'Kunci operator logging belum dikonfigurasi.');
      const supplied = /^Bearer ([^\s]{32,256})$/.exec(request.headers.get('authorization') || '')?.[1] || '';
      if (!supplied || !secretsEqual(supplied, key)) throw new HttpError(401, 'Kunci operator salah atau belum diisi.', { 'WWW-Authenticate': 'Bearer' });
      await enforceIngestRate(redis, { ...config, ingestPerMinute: 20 }, ':logging-control');
      const body = await readJson(request);
      if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || !['start', 'stop'].includes(body.action)) throw new HttpError(400, 'Pilih tindakan start atau stop.');
      return jsonResponse({ ok: true, ...await setLoggingState(redis, config, body.action === 'start', clock()), requiresKey: true });
    } catch (error) { return errorResponse(error); }
  };
}

export default { fetch: createLoggingHandler() };
