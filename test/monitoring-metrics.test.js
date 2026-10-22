import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { apiMetrics, labels } from '../src/monitoring/metrics.js';
import { createCollector, workerMetrics } from '../src/monitoring/collector.js';

describe('api metrics labels', () => {
  it('counts per method, route pattern and status, never raw URLs', async () => {
    const app = Fastify();
    const render = apiMetrics(app);
    app.get('/api/v1/jurnal/:id', async (request, reply) => (request.params.id === 'boom' ? reply.code(500).send({}) : { ok: true }));
    app.post('/api/v1/jurnal', async (_r, reply) => reply.code(201).send({}));
    app.get('/health', async () => ({ ok: true }));
    try {
      await app.inject('/api/v1/jurnal/1');
      await app.inject('/api/v1/jurnal/2');
      await app.inject('/api/v1/jurnal/boom');
      await app.inject({ method: 'POST', url: '/api/v1/jurnal' });
      await app.inject('/health');
      await app.inject('/api/v1/tidak-ada/123');
      const out = render();
      expect(out).toContain('api_requests_total{method="GET",route="/api/v1/jurnal/:id",status="200"} 2\n');
      expect(out).toContain('api_requests_total{method="GET",route="/api/v1/jurnal/:id",status="500"} 1\n');
      expect(out).toContain('api_requests_total{method="POST",route="/api/v1/jurnal",status="201"} 1\n');
      expect(out).toContain('api_errors_5xx_total 1\n');
      expect(out).toContain('api_request_duration_seconds_count{method="GET",route="/api/v1/jurnal/:id"} 3\n');
      expect(out).toContain('api_request_duration_seconds_bucket{method="GET",route="/api/v1/jurnal/:id",le="+Inf"} 3\n');
      expect(out).not.toContain('/jurnal/1"');
      expect(out).not.toContain('/health');
      expect(out).not.toContain('tidak-ada');
    } finally { await app.close(); }
  });
  it('escapes label values', () => {
    expect(labels({ a: String.raw`x"y\z` + '\nw' })).toBe(String.raw`{a="x\"y\\z\nw"}`);
  });
});

describe('worker metrics from collector snapshot', () => {
  const syncLog = [
    { arah: 'tarik', status: 'sukses', cycles: 10, baru: '5', ubah: '7', gagal: '0', last_at: 2000 },
    { arah: 'tarik', status: 'gagal', cycles: 2, baru: '0', ubah: '0', gagal: '3', last_at: 2100 },
    { arah: 'kirim', status: 'sukses', cycles: 9, baru: '4', ubah: '0', gagal: '0', last_at: 1900 },
    { arah: 'aneh"', status: 'x', cycles: 1, baru: 0, ubah: 0, gagal: 0, last_at: 1 },
  ];
  it('renders counters, last success and backlog gauges with bounded labels', () => {
    const out = workerMetrics({ syncLog,
      payments: [{ status: 'dijurnal', count: 1500 }, { status: 'perlu_ditinjau', count: 2 }, { status: '<script>', count: 1 }],
      outboxItems: [{ status: 'terkirim', count: 40 }, { status: 'gagal', count: 1 }] });
    expect(out).toContain('sync_cycles_total{direction="pull",status="sukses"} 10\n');
    expect(out).toContain('sync_cycles_total{direction="pull",status="gagal"} 2\n');
    expect(out).toContain('sync_rows_total{direction="pull",kind="new"} 5\n');
    expect(out).toContain('sync_rows_total{direction="pull",kind="failed"} 3\n');
    expect(out).toContain('sync_rows_total{direction="push",kind="new"} 4\n');
    expect(out).toContain('sync_last_success_timestamp_seconds{direction="pull"} 2000\n');
    expect(out).toContain('sync_last_success_timestamp_seconds{direction="push"} 1900\n');
    expect(out).toContain('sync_cycles_total{direction="lain",status="lain"} 1\n');
    expect(out).toContain('payments_by_status{status="dijurnal"} 1500\n');
    expect(out).toContain('payments_by_status{status="menunggu"} 0\n');
    expect(out).toContain('payments_by_status{status="lain"} 1\n');
    expect(out).toContain('outbox_items{status="tertunda"} 0\n');
    expect(out).toContain('outbox_items{status="gagal"} 1\n');
    expect(out).not.toContain('aneh');
    expect(out).not.toContain('<script>');
  });
  it('is included in collector output after a successful collection', async () => {
    const snapshot = { invariants: {}, errors: 0, outbox: 0, held_since: null, cycle_at: 1, syncLog, payments: [], outboxItems: [] };
    const collector = createCollector({ begin: async () => snapshot }, { now: () => 3_000_000, backupFile: undefined });
    await collector.refresh();
    expect(collector.render()).toContain('sync_cycles_total{direction="push",status="sukses"} 9\n');
  });
});
