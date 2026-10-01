// src/plugins/redis.js
import fp from 'fastify-plugin';
import fastifyRedis from '@fastify/redis';
import { setRedisClient } from '../shared/utils/redis.js';
import { env } from '../config/env.js';

/**
 * Redis boleh dipakai bersama Track. Semua key SI diberi prefix "si:" supaya
 * tidak pernah bertabrakan dengan key Track (mis. throttle:login:<email>).
 */
async function redisPlugin(fastify) {
  await fastify.register(fastifyRedis, {
    url: env.redisUrl,
    keyPrefix: 'si:',
  });

  setRedisClient(fastify.redis);
  fastify.log.info('Redis connected (prefix si:)');
}

export default fp(redisPlugin, { name: 'redis-plugin' });
