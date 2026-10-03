import { errorResponse, HttpError, jsonResponse, logConfig } from '../server/log-config.js';
import { createRedis } from '../server/redis-rest.js';
import { parseLogQuery, readEvents } from '../server/log-store.js';

export function createLogsHandler({ env = process.env, clock = Date.now, redisFactory = createRedis } = {}) {
  return async request => {
    try {
      // This public route has no write, edit, delete, or arbitrary Redis command path.
      if (request.method !== 'GET') throw new HttpError(405, 'Riwayat hanya dapat dibaca melalui GET.', { Allow: 'GET' });
      const config = logConfig(env);
      const query = parseLogQuery(request.url, config, clock());
      return jsonResponse(await readEvents(redisFactory(env), config, query));
    } catch (error) { return errorResponse(error); }
  };
}

export default { fetch: createLogsHandler() };
