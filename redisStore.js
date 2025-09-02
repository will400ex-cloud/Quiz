// redisStore.js — Internal URL (no TLS) for Render Key Value
// Usage côté serveur: import store from './redisStore.js'; await store.saveState(pin, state);

let redis = null;
let mode = 'memory';
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
    const Redis = mod.default;
    // AUCUN TLS ICI — on prend l’URL telle quelle (Internal URL Render)
    // Exemple attendu: redis://red-d2rmetumcj7s73ets92g:6379
    redis = new Redis(process.env.REDIS_URL);
    mode = 'redis';
    redis.on('connect', () => console.log('[redisStore] Redis connected (no TLS)'));
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
    const raw = (mode === 'redis') ? await redis.get(key) : await memGet(key);
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
