// src/app.js
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyHelmet from '@fastify/helmet';
import { sql } from 'drizzle-orm';

import { env } from './config/env.js';
import { db } from './config/database.js';
import authPlugin from './plugins/auth.js';
import validatorPlugin from './plugins/validator.js';
import swaggerPlugin from './plugins/swagger.js';
import redisPlugin from './plugins/redis.js';
import { globalErrorHandler } from './shared/utils/errorHandler.js';
import { getRedisClient } from './shared/utils/redis.js';

import authRoutes from './modules/auth/auth.routes.js';
import trackRoutes from './modules/track/track.routes.js';

export async function buildApp({ logger = true } = {}) {
  const app = Fastify({
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: true,
    logger: logger && {
      transport: {
        target: 'pino-pretty',
        options: { ignore: 'pid,hostname,time', colorize: true },
      },
    },
  });

  await app.register(fastifyCors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (env.frontendUrls.includes(origin)) return cb(null, true);
      if (env.isDevelopment && origin.startsWith('http://localhost:')) return cb(null, true);
      const err = new Error('Not allowed by CORS');
      err.statusCode = 403;
      return cb(err, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  });

  await app.register(fastifyCookie, { secret: env.cookieSecret, hook: 'onRequest' });

  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'validator.swagger.io'],
        connectSrc: ["'self'"],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true },
    frameguard: { action: 'deny' },
    noSniff: true,
  });

  await app.register(authPlugin);
  await app.register(validatorPlugin);
  // Swagger UI hanya aktif bila NODE_ENV eksplisit 'development'
  if (env.isDevelopment) await app.register(swaggerPlugin);
  await app.register(redisPlugin);

  await app.register(fastifyRateLimit, {
    max: 300,
    timeWindow: '1 minute',
    redis: getRedisClient(),
    nameSpace: 'ratelimit:',
  });

  app.setErrorHandler(globalErrorHandler);

  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(trackRoutes, { prefix: '/api/v1/track' });

  app.get('/', async (_request, reply) => reply.code(404).type('text/plain').send(''));

  app.get('/health', async (_request, reply) => {
    const checks = { server: 'ok', database: 'unknown', redis: 'unknown' };

    try {
      await db.execute(sql`SELECT 1`);
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }

    try {
      const redis = getRedisClient();
      checks.redis = redis ? ((await redis.ping()) === 'PONG' ? 'ok' : 'error') : 'not_connected';
    } catch {
      checks.redis = 'error';
    }

    const isHealthy = checks.database === 'ok' && checks.redis === 'ok';
    return reply.code(isHealthy ? 200 : 503).send({
      success: isHealthy,
      status: isHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      checks,
    });
  });

  return app;
}
