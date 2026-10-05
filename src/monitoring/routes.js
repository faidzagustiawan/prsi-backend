import { createHash, timingSafeEqual } from 'node:crypto';
import { FIELDS } from './checksum.js';

export function validToken(header, token) {
  if (typeof token !== 'string' || token.length < 32 || typeof header !== 'string') return false;
  const digest = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${token}`));
}

export default async function monitoringRoutes(app, { collector, checksum, metrics, token, poll = true }) {
  app.addHook('onRequest', async (request, reply) => {
    if (!validToken(request.headers.authorization, token)) return reply.code(401).send({ message: 'Unauthorized' });
  });
  const options = { schema: { hide: true }, config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: (r) => r.socket.remoteAddress } } };
  app.get('/metrics', options, async (_request, reply) => reply.type('text/plain; version=0.0.4; charset=utf-8').send(collector.render() + metrics()));
  app.get('/checksum/:entity', options, async (request, reply) => {
    if (!Object.hasOwn(FIELDS, request.params.entity)) return reply.code(404).send({ message: 'Not found' });
    try {
      return await checksum(request.params.entity);
    } catch {
      return reply.code(503).send({ message: 'Checksum unavailable' });
    }
  });
  if (poll && token?.length >= 32) {
    app.addHook('onReady', async () => { void collector.refresh(); });
    const timer = setInterval(() => { void collector.refresh(); }, 300_000);
    timer.unref();
    app.addHook('onClose', async () => { clearInterval(timer); });
  }
}
