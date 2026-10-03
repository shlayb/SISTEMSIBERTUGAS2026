import { HttpError } from './log-config.js';

// No browser SDK, connection pool, or automatic retry. The caller may safely retry ingest.
export function createRedis(env = process.env, fetchImpl = fetch) {
  const endpoint = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  let url;
  try { url = new URL(endpoint); } catch { /* Fail closed below. */ }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !token) {
    throw new HttpError(503, 'Database log belum dikonfigurasi.');
  }
  return {
    async command(args) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetchImpl(url.href, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(args), signal: controller.signal, redirect: 'error', cache: 'no-store'
        });
        if (!response.ok) throw new Error('Redis unavailable');
        const data = await response.json();
        if (!data || data.error || !Object.hasOwn(data, 'result')) throw new Error('Redis response invalid');
        return data.result;
      } finally { clearTimeout(timer); }
    }
  };
}
