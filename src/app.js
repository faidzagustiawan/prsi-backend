// src/app.js
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyHelmet from '@fastify/helmet';
import fastifyMultipart from '@fastify/multipart';
import { sql } from 'drizzle-orm';

import { env } from './config/env.js';
import { db, reportClient } from './config/database.js';
import monitoringRoutes from './monitoring/routes.js';
import { checksum } from './monitoring/checksum.js';
import { createCollector } from './monitoring/collector.js';
import { apiMetrics } from './monitoring/metrics.js';
import authPlugin from './plugins/auth.js';
import validatorPlugin from './plugins/validator.js';
import swaggerPlugin from './plugins/swagger.js';
import redisPlugin from './plugins/redis.js';
import { globalErrorHandler } from './shared/utils/errorHandler.js';
import { getRedisClient } from './shared/utils/redis.js';

import authRoutes from './modules/auth/auth.routes.js';
import proyekRoutes from './modules/proyek/proyek.routes.js';
import masterPtRoutes from './modules/master-pt/master-pt.routes.js';
import akunRoutes from './modules/akun/akun.routes.js';
import kodePembantuRoutes from './modules/kode-pembantu/kode-pembantu.routes.js';
import saldoAwalRoutes from './modules/saldo-awal/saldo-awal.routes.js';
import periodeRoutes from './modules/periode/periode.routes.js';
import jurnalRoutes from './modules/jurnal/jurnal.routes.js';
import lampiranRoutes from './modules/lampiran/lampiran.routes.js';
import laporanRoutes from './modules/laporan/laporan.routes.js';
import hutangRoutes from './modules/hutang/hutang.routes.js';
import pinjamanRoutes from './modules/pinjaman/pinjaman.routes.js';
import kontrakRoutes from './modules/kontrak/kontrak.routes.js';
import shmRoutes from './modules/shm/shm.routes.js';
import akunSistemRoutes from './modules/akun-sistem/akun-sistem.routes.js';
import pasalRoutes from './modules/legal/pasal.routes.js';
import templateRoutes from './modules/legal/template.routes.js';
import dokumenRoutes from './modules/legal/dokumen.routes.js';
import { piutangRoutes, pembayaranTrackRoutes } from './modules/penjualan/piutang.routes.js';
import sinkronRoutes from './modules/sinkron/sinkron.routes.js';
import { LAMPIRAN_MAKS_BYTES } from './shared/constants.js';

export async function buildApp({ logger = true, documentationOnly = false } = {}) {
  const app = Fastify({
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: true,
    logger: logger && (env.isDevelopment ? {
      transport: {
        target: 'pino-pretty',
        options: { ignore: 'pid,hostname,time', colorize: true },
      },
    } : true),
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

  // Satu berkas per request; ukuran dibatasi lagi per jenis lampiran di service
  await app.register(fastifyMultipart, { limits: { fileSize: LAMPIRAN_MAKS_BYTES, files: 1, fields: 5 } });

  await app.register(authPlugin);
  await app.register(validatorPlugin);
  // Only OpenAPI JSON is served; Scalar is a separate local docs artifact.
  await app.register(swaggerPlugin);
  // Offline exporter registers routes without connecting to Redis or running handlers.
  if (!documentationOnly) await app.register(redisPlugin);

  await app.register(fastifyRateLimit, {
    max: 300,
    timeWindow: '1 minute',
    redis: getRedisClient(),
    nameSpace: 'ratelimit:',
  });

  app.setErrorHandler(globalErrorHandler);

  const metrics = apiMetrics(app);
  await app.register(monitoringRoutes, {
    prefix: '/internal', collector: createCollector(reportClient), metrics,
    checksum: (entity) => checksum(reportClient, entity),
    token: process.env.PRSI_MONITOR_TOKEN, poll: !documentationOnly,
  });

  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(proyekRoutes, { prefix: '/api/v1/proyek' });
  await app.register(masterPtRoutes, { prefix: '/api/v1/master-pt' });
  await app.register(akunRoutes, { prefix: '/api/v1/akun' });
  await app.register(kodePembantuRoutes, { prefix: '/api/v1/kode-pembantu' });
  await app.register(saldoAwalRoutes, { prefix: '/api/v1/saldo-awal' });
  await app.register(periodeRoutes, { prefix: '/api/v1/periode' });
  await app.register(jurnalRoutes, { prefix: '/api/v1/jurnal' });
  await app.register(lampiranRoutes, { prefix: '/api/v1/lampiran' });
  await app.register(laporanRoutes, { prefix: '/api/v1/laporan' });
  await app.register(hutangRoutes, { prefix: '/api/v1/hutang' });
  await app.register(pinjamanRoutes, { prefix: '/api/v1/pinjaman' });
  await app.register(kontrakRoutes, { prefix: '/api/v1/kontrak' });
  await app.register(shmRoutes, { prefix: '/api/v1/shm' });
  await app.register(akunSistemRoutes, { prefix: '/api/v1/akun-sistem' });
  await app.register(pasalRoutes, { prefix: '/api/v1/pasal' });
  await app.register(templateRoutes, { prefix: '/api/v1/template-dokumen' });
  await app.register(dokumenRoutes, { prefix: '/api/v1/dokumen' });
  await app.register(piutangRoutes, { prefix: '/api/v1/piutang' });
  await app.register(pembayaranTrackRoutes, { prefix: '/api/v1/pembayaran-track' });
  await app.register(sinkronRoutes, { prefix: '/api/v1/sinkron' });

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
