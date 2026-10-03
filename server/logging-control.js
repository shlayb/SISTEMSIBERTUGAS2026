import { randomUUID } from 'node:crypto';

export const loggingControlKey = config => `${config.prefix}:control`;

const CONTROL_SCRIPT = `
local current = redis.call('GET', KEYS[1])
local next = cjson.decode(ARGV[1])
if current then
  local previous = cjson.decode(current)
  if previous.enabled == next.enabled then return current end
end
redis.call('SET', KEYS[1], ARGV[1])
return ARGV[1]
`;

function parseState(raw) {
  if (raw === null) return { enabled: false, changedAt: null, revision: 'initial' };
  const state = JSON.parse(raw);
  if (!state || typeof state.enabled !== 'boolean' || typeof state.revision !== 'string' || typeof state.changedAt !== 'string' || !Number.isFinite(Date.parse(state.changedAt))) throw new Error('Invalid logging state');
  return { enabled: state.enabled, changedAt: state.changedAt, revision: state.revision };
}

export async function getLoggingState(redis, config) {
  return parseState(await redis.command(['GET', loggingControlKey(config)]));
}

export async function setLoggingState(redis, config, enabled, now = Date.now()) {
  const state = { enabled, changedAt: new Date(now).toISOString(), revision: randomUUID() };
  return parseState(await redis.command(['EVAL', CONTROL_SCRIPT, 1, loggingControlKey(config), JSON.stringify(state)]));
}
