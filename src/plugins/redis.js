// src/plugins/redis.js
import fp from 'fastify-plugin';
import fastifyRedis from '@fastify/redis';
import net from 'node:net';
import { setRedisClient } from '../shared/utils/redis.js';
import { env } from '../config/env.js';

/** Cek cepat apakah port Redis bisa dijangkau, tanpa menunggu retry ioredis. */
const isReachable = (redisUrl, timeoutMs = 1000) =>
  new Promise((resolve) => {
    const { hostname, port } = new URL(redisUrl);
    const socket = net.connect({ host: hostname, port: Number(port) || 6379 });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });

/**
 * Redis boleh dipakai bersama Track. Semua key SI diberi prefix "si:" supaya
 * tidak pernah bertabrakan dengan key Track (mis. throttle:login:<email>).
 *
 * Di development, Redis opsional: bila tidak terjangkau server tetap jalan
 * (throttle login fail-open, rate limit memakai memori). Di produksi wajib.
 */
async function redisPlugin(fastify) {
  if (env.isDevelopment && !(await isReachable(env.redisUrl))) {
    setRedisClient(null);
    fastify.log.warn(`Redis tidak terjangkau di ${env.redisUrl} - development berjalan tanpa Redis`);
    return;
  }

  await fastify.register(fastifyRedis, {
    url: env.redisUrl,
    keyPrefix: 'si:',
  });

  setRedisClient(fastify.redis);
  fastify.log.info('Redis connected (prefix si:)');
}

export default fp(redisPlugin, { name: 'redis-plugin' });
