import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../src/config/database.js', () => ({ db: {}, reportDb: {}, client: {} }));
vi.mock('../src/config/env.js', () => ({ env: { isDevelopment: false, sync: {} } }));

const { ENTITIES } = await import('../src/sync/mapping.js');
const { createTrackClient, assertConfig, TrackError, parseCursor } = await import('../src/sync/track-client.js');

const cfg = { trackApiUrl: 'https://track.example', readToken: 'r', scheduleToken: 's', pageSize: 100 };

describe('mapping payload Track', () => {
  it('menerima pembayaran Track apa adanya, termasuk bukti berupa array', () => {
    const p = ENTITIES.payments.schema.parse({
      assignment_id: '6f1d1c3a-6b3e-4f0e-9a51-6d7d8c1c2b10', jumlah_bayar: 1500000, tanggal_bayar: '2026-10-03T00:00:00.000Z',
      bukti_pembayaran: ['https://r2.example/a.jpg'], is_auto_inject: false, jenis: 'angsuran', status_verifikasi: 'terverifikasi',
    });
    const row = ENTITIES.payments.toRow(p, { assignment_id: 'local' });
    expect(row.nominal).toBe('1500000');
    expect(row.tanggal).toBe('2026-10-03');
    expect(row.buktiUrl).toBe('["https://r2.example/a.jpg"]');
    expect(row.assignmentId).toBe('local');
  });

  it('menolak nominal yang bukan angka dan tipe pembayaran yang tidak dikenal', () => {
    expect(ENTITIES.payments.schema.safeParse({ assignment_id: '6f1d1c3a-6b3e-4f0e-9a51-6d7d8c1c2b10', jumlah_bayar: '1,5 jt', tanggal_bayar: '2026-10-03' }).success).toBe(false);
    expect(ENTITIES.assignments.schema.safeParse({
      user_id: '6f1d1c3a-6b3e-4f0e-9a51-6d7d8c1c2b10', unit_id: '6f1d1c3a-6b3e-4f0e-9a51-6d7d8c1c2b11', tipe_pembayaran: 'barter',
    }).success).toBe(false);
  });

  it('tidak pernah meneruskan kolom di luar whitelist (mis. password_hash)', () => {
    const p = ENTITIES.customers.schema.parse({ nama: 'Budi', password_hash: 'x', apple_refresh_token: 'y' });
    expect(Object.keys(ENTITIES.customers.toRow(p))).not.toContain('password_hash');
    expect(JSON.stringify(ENTITIES.customers.toRow(p))).not.toContain('x');
  });
});

describe('klien Track', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('wajib https di luar development', () => {
    expect(() => assertConfig({ ...cfg, trackApiUrl: 'http://track.example' })).toThrow(/https/);
    expect(() => assertConfig({ ...cfg, readToken: '' })).toThrow(/TRACK_SYNC_TOKEN/);
  });

  it('memakai token baca untuk GET dan token jadwal untuk PUT', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push({ url: String(url), auth: init.headers.Authorization, method: init.method, key: init.headers['Idempotency-Key'] });
      return new Response(JSON.stringify(init.method === 'GET' ? { events: [], next_after_seq: 5, has_more: false } : { data: { track_id: 't' } }));
    }));
    const c = createTrackClient(cfg);
    await c.events(5);
    await c.putSchedule('j1', { versi: 1 }, 'outbox-1');
    expect(calls[0]).toMatchObject({ url: 'https://track.example/sync/v1/events?after_seq=5&limit=100', auth: 'Bearer r', method: 'GET' });
    expect(calls[1]).toMatchObject({ url: 'https://track.example/sync/v1/schedules/j1', auth: 'Bearer s', method: 'PUT', key: 'outbox-1' });
  });

  it('menolak respons yang tidak sesuai kontrak', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ events: [{ seq: 'x' }], next_after_seq: 1 }))));
    await expect(createTrackClient(cfg).events(0)).rejects.toThrow(TrackError);
  });

  it('409 dan 5xx dibedakan: 5xx boleh diulang, 401 tidak', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'down' }), { status: 503 })));
    await expect(createTrackClient(cfg).checksum('units')).rejects.toMatchObject({ status: 503, retryable: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'token' }), { status: 401 })));
    await expect(createTrackClient(cfg).checksum('units')).rejects.toMatchObject({ status: 401, retryable: false });
  });
});

describe('kontrak v2 (cursor urutan commit)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('parseCursor hanya menerima "txid:seq" desimal', () => {
    expect(parseCursor('0:67')).toEqual({ txid: 0, seq: 67 });
    expect(parseCursor('812:1201')).toEqual({ txid: 812, seq: 1201 });
    for (const bad of ['', '1', '1:', ':1', '-1:0', '1:2:3', 'a:1', '99999999999999999:0']) expect(parseCursor(bad)).toBeNull();
  });

  it('memanggil /sync/v2/events dengan cursor dan /sync/v2/start', async () => {
    const urls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify(String(url).includes('/start')
        ? { after: '900:0' }
        : { events: [{ seq: 5, entity: 'units', entity_id: 'u', op: 'U', row_version: 9, payload: {}, cursor: '901:5' }], next_after: '901:5', has_more: false, held_by_open_transaction: false }));
    }));
    const c = createTrackClient(cfg);
    expect((await c.startV2()).after).toBe('900:0');
    expect((await c.eventsV2('900:0')).next_after).toBe('901:5');
    expect(urls).toEqual(['https://track.example/sync/v2/start', 'https://track.example/sync/v2/events?after=900%3A0&limit=100']);
  });

  it('menolak respons v2 tanpa cursor yang sah', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ events: [{ seq: 5, entity: 'units', entity_id: 'u', op: 'U', row_version: 9 }], next_after: '1:5', has_more: false }))));
    await expect(createTrackClient(cfg).eventsV2('0:0')).rejects.toThrow(TrackError);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ events: [], next_after: 'x', has_more: false }))));
    await expect(createTrackClient(cfg).eventsV2('0:0')).rejects.toThrow(TrackError);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ after: '5' }))));
    await expect(createTrackClient(cfg).startV2()).rejects.toThrow(TrackError);
  });
});
