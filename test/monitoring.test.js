import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import routes, { validToken } from '../src/monitoring/routes.js';
import { createCollector } from '../src/monitoring/collector.js';
import { checksumSql } from '../src/monitoring/checksum.js';

const token = 'test-only-'.repeat(8);
describe('private monitoring', () => {
  it('fails closed for missing, short, malformed and incorrect tokens', () => {
    for (const input of [undefined, '', 'Bearer wrong', `Basic ${token}`, `Bearer ${token}x`]) expect(validToken(input, token)).toBe(false);
    expect(validToken(`Bearer ${token}`, undefined)).toBe(false);
    expect(validToken('Bearer short', 'short')).toBe(false);
    expect(validToken(`Bearer ${token}`, token)).toBe(true);
  });
  it('authenticates without user session, rate limits and rejects unknown entities', async () => {
    const app = Fastify();
    await app.register(rateLimit, { global: false });
    const checksum = vi.fn(async () => ({ count: 0, hash: 'hash', content_hash: 'hash', cursor: '0:0', held: false }));
    await app.register(routes, { prefix: '/internal', token, poll: false, checksum,
      collector: { render: () => 'monitor_collection_success 1\n' }, metrics: () => '' });
    try {
      expect((await app.inject('/internal/metrics')).statusCode).toBe(401);
      const headers = { authorization: `Bearer ${token}` };
      expect((await app.inject({ url: '/internal/checksum/companies', headers })).json().count).toBe(0);
      expect((await app.inject({ url: '/internal/checksum/__proto__', headers })).statusCode).toBe(404);
      checksum.mockRejectedValueOnce(new Error('PRIVATE_PAYLOAD'));
      const failed = await app.inject({ url: '/internal/checksum/payments', headers });
      expect(failed.statusCode).toBe(503);
      expect(failed.body).not.toContain('PRIVATE_PAYLOAD');
      for (let i = 0; i < 61; i += 1) await app.inject({ url: '/internal/metrics', headers });
      expect((await app.inject({ url: '/internal/metrics', headers })).statusCode).toBe(429);
    } finally { await app.close(); }
  });
  it('does not query the database on scrape and reports failed collection', async () => {
    const begin = vi.fn().mockRejectedValue(new Error('PRIVATE_PAYLOAD'));
    const collector = createCollector({ begin });
    expect(collector.render()).toContain('monitor_collection_success 0');
    expect(begin).not.toHaveBeenCalled();
    await collector.refresh();
    expect(collector.render()).not.toContain('PRIVATE_PAYLOAD');
    expect(collector.render()).not.toContain('accounting_invariant_violations');
  });
  it('only generates checksum SQL for whitelisted entities', () => {
    expect(() => checksumSql('companies; DROP SCHEMA finance')).toThrow();
    expect(checksumSql('payments')).toContain('HH24:MI:SS.US');
  });
});
