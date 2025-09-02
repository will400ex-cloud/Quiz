// redisStore.js
// Usage: import store from './redisStore.js';
// await store.saveState(pin, state); const s = await store.loadState(pin);

let redis = null;
let mode = 'memory';
let RedisCtor = null;

const DEFAULT_TTL = Number(process.env.QUIZ_STATE_TTL || 6 * 60 * 60); // 6h
const KEY_PREFIX = process.env.QUIZ_STATE_PREFIX || 'quiz:state:';
const memory = new Map();

async function memSet(key, value, ttlSec = DEFAULT_TTL) {
  memory.set(key, { value, expireAt: Date.now() + ttlSec * 1000 });
  return 'OK';
}
async function memGet(key) {
  const hit = memory.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expireAt) { memory.delete(key); return null; }
  return hit.value;
}
async function memDel(key) { memory.delete(key); return 1; }

try {
  const mod = await import('ioredis').catch(() => null);
  if (mod?.default && process.env.REDIS_URL) {
    RedisCtor = mod.default;
    redis = new RedisCtor(process.env.REDIS_URL, { tls: {} }); // TLS requis sur Render
    mode = 'redis';
    redis.on('connect', () => console.log('[redisStore] Redis connected'));
    redis.on('error', (e) => console.error('[redisStore] Redis error:', e));
  } else {
    console.log('[redisStore] REDIS_URL absent ou ioredis non dispo → fallback mémoire');
  }
} catch (e) {
  console.log('[redisStore] init error → fallback mémoire:', e?.message);
}

const keyForPin = (pin) => `${KEY_PREFIX}${String(pin)}`;

const store = {
  async saveState(pin, stateObj, ttlSec = DEFAULT_TTL) {
    const payload = JSON.stringify({ ...stateObj, _savedAt: Date.now(), _v: 1 });
    const key = keyForPin(pin);
    if (mode === 'redis') return redis.set(key, payload, 'EX', ttlSec);
    return memSet(key, payload, ttlSec);
  },
  async loadState(pin) {
    const key = keyForPin(pin);
    let raw = (mode === 'redis') ? await redis.get(key) : await memGet(key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  },
  async deleteState(pin) {
    const key = keyForPin(pin);
    return (mode === 'redis') ? redis.del(key) : memDel(key);
  },
  async ping() {
    if (mode === 'redis') {
      try { await redis.ping(); return { ok: true, mode: 'redis' }; }
      catch (e) { return { ok: false, mode: 'redis', error: e.message }; }
    }
    return { ok: true, mode: 'memory' };
  },
  mode() { return mode; },
};

export default store;
