// src/shared/utils/throttle.js
import { getRedisClient } from './redis.js';

/**
 * Penghitung percobaan per identitas (email), disimpan di Redis.
 * Limit per-IP saja tidak cukup karena CGNAT operator seluler.
 * Fail-open: kalau Redis mati, pengguna tidak ikut terkunci; limit per-IP
 * di Fastify tetap berlaku.
 */
const safe = async (fn, fallback) => {
  try {
    const redis = getRedisClient();
    if (!redis) return fallback;
    return await fn(redis);
  } catch (err) {
    console.error('[Throttle] Redis error:', err.message);
    return fallback;
  }
};

export const hitAttempt = async (key, { max, windowSec }) =>
  safe(async (redis) => {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, windowSec);
    const ttl = await redis.ttl(key);
    return { count, exceeded: count > max, retryAfterSec: ttl > 0 ? ttl : windowSec };
  }, { count: 0, exceeded: false, retryAfterSec: 0 });

export const peekAttempt = async (key, { max }) =>
  safe(async (redis) => {
    const raw = await redis.get(key);
    const count = raw ? parseInt(raw, 10) : 0;
    const ttl = await redis.ttl(key);
    return { count, exceeded: count > max, retryAfterSec: ttl > 0 ? ttl : 0 };
  }, { count: 0, exceeded: false, retryAfterSec: 0 });

export const clearAttempt = async (key) =>
  safe(async (redis) => { await redis.del(key); return true; }, false);

export const formatWait = (sec) => {
  if (!sec || sec <= 0) return 'beberapa saat';
  if (sec < 60) return `${sec} detik`;
  return `${Math.ceil(sec / 60)} menit`;
};

export const throttleKeys = {
  login: (email) => `throttle:login:${String(email).toLowerCase()}`,
};
