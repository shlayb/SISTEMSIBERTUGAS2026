import { authenticateSource, errorResponse, HttpError, jsonResponse, logConfig } from '../server/log-config.js';
import { createRedis } from '../server/redis-rest.js';
import { enforceIngestRate, insertEvent } from '../server/log-store.js';
import { readJson, validateEvent } from '../server/log-validation.js';

export function createIngestHandler({ env = process.env, clock = Date.now, redisFactory = createRedis } = {}) {
  return async request => {
    try {
      if (request.method !== 'POST') throw new HttpError(405, 'Gunakan POST untuk ingest.', { Allow: 'POST' });
      const source = authenticateSource(request, env);
      const config = logConfig(env);
      const receivedAt = clock();
      const redis = redisFactory(env);
      await enforceIngestRate(redis, config, source.id);
      const event = validateEvent(await readJson(request), source, receivedAt, config.retentionDays);
      const result = await insertEvent(redis, config, event);
      return jsonResponse({ ok: true, recorded: !result.skipped, ...result }, result.duplicate || result.skipped ? 200 : 201);
    } catch (error) { return errorResponse(error); }
  };
}

export default { fetch: createIngestHandler() };
