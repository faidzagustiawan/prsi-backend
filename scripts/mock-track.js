// Server tiruan API sinkronisasi PR Track (docs/TrackSyncAPI.md), untuk
// development dan test sebelum API asli di Track siap.
//
//   npm run mock:track        (port MOCK_TRACK_PORT, default 3900)
//
// Isi awal disalin dari cermin trk_* di database dev SI supaya checksum awal
// cocok. Endpoint /_mock/* (tanpa token, hanya untuk dev) mensimulasikan
// perubahan di Track: tambah/ubah/hapus baris, lubang seq, dan perubahan yang
// "terlewat" event (untuk menguji rekonsiliasi).
import Fastify from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, closeDatabase } from '../src/config/database.js';
import { env } from '../src/config/env.js';

const ENTITIES = ['companies', 'projects', 'clusters', 'units', 'customers', 'assignments', 'payments'];

const BOOT_SQL = {
  companies: sql`SELECT track_id id, row_version v, nama nama_pt, kode kode_pt, alamat FROM finance.trk_companies WHERE NOT is_deleted`,
  projects: sql`SELECT p.track_id id, p.row_version v, c.track_id company_id, p.nama nama_proyek, p.kode, p.status
    FROM finance.trk_projects p JOIN finance.trk_companies c ON c.id = p.company_id WHERE NOT p.is_deleted`,
  clusters: sql`SELECT c.track_id id, c.row_version v, p.track_id project_id, c.nama nama_cluster
    FROM finance.trk_clusters c JOIN finance.trk_projects p ON p.id = c.project_id WHERE NOT c.is_deleted`,
  units: sql`SELECT u.track_id id, u.row_version v, c.track_id cluster_id, u.kode nomor_unit, u.tipe tipe_rumah,
    u.luas_tanah, u.luas_bangunan, u.status status_pembangunan
    FROM finance.trk_units u JOIN finance.trk_clusters c ON c.id = u.cluster_id WHERE NOT u.is_deleted`,
  customers: sql`SELECT track_id id, row_version v, nama, email, no_hp nomor_telepon, tempat_lahir, tanggal_lahir::text, pekerjaan, alamat, no_ktp
    FROM finance.trk_customers WHERE NOT is_deleted`,
  assignments: sql`SELECT a.track_id id, a.row_version v, c.track_id user_id, u.track_id unit_id, a.tipe_pembayaran,
    a.harga::text harga_total, a.uang_muka::text dp, a.status status_kepemilikan, a.tanggal tanggal_pembelian
    FROM finance.trk_assignments a JOIN finance.trk_customers c ON c.id = a.customer_id JOIN finance.trk_units u ON u.id = a.unit_id
    WHERE NOT a.is_deleted`,
  payments: sql`SELECT p.track_id id, p.row_version v, a.track_id assignment_id, p.nominal::text jumlah_bayar, p.tanggal::text tanggal_bayar,
    p.catatan, p.bukti_url bukti_pembayaran, p.is_auto_inject, p.source_created_at created_at, p.jenis, p.status_verifikasi,
    p.rekening_tujuan, p.diverifikasi_oleh, p.diverifikasi_pada
    FROM finance.trk_payments p JOIN finance.trk_assignments a ON a.id = p.assignment_id WHERE NOT p.is_deleted`,
};

// ── State Track tiruan ──────────────────────────────────────
const store = Object.fromEntries(ENTITIES.map((e) => [e, new Map()]));
const events = [];
const received = { schedules: new Map(), locks: new Map() };
let seq = 0;

async function boot() {
  // seq Track tidak pernah mundur; tiruan melanjutkan dari posisi cursor SI
  const [c] = await db.execute(sql`SELECT COALESCE(MAX(GREATEST(cursor_seq, COALESCE(gap_seq, 0))), 0) n FROM finance.sync_cursor`);
  seq = Number(c.n);
  for (const entity of ENTITIES) {
    for (const { id, v, ...row } of await db.execute(BOOT_SQL[entity])) {
      store[entity].set(id, { row: { id, ...row }, version: Number(v) });
    }
  }
}

function emit(entity, id, op) {
  seq += 1;
  const item = store[entity].get(id);
  events.push({
    seq, entity, entity_id: id, op, row_version: item?.version ?? 0,
    payload: op === 'D' ? null : item.row, created_at: new Date().toISOString(),
  });
}

const tokenOk = (request, token) => request.headers.authorization === `Bearer ${token}`;

const app = Fastify({ logger: false });

app.addHook('onRequest', async (request, reply) => {
  if (request.url.startsWith('/_mock')) return;
  const isWrite = request.method === 'PUT';
  const token = isWrite ? env.sync.scheduleToken : env.sync.readToken;
  if (!tokenOk(request, token)) reply.code(401).send({ message: 'Token tidak valid' });
});

// ── Kontrak /sync/v1 ────────────────────────────────────────
app.get('/sync/v1/events', async (request) => {
  const after = Number(request.query.after_seq ?? 0);
  const limit = Math.min(Number(request.query.limit ?? 500), 1000);
  const page = events.filter((e) => e.seq > after).slice(0, limit);
  return { events: page, next_after_seq: page.at(-1)?.seq ?? after, has_more: events.some((e) => e.seq > (page.at(-1)?.seq ?? after)), server_time: new Date().toISOString() };
});

// ── Kontrak /sync/v2 (cursor "txid:seq") ────────────────────
// Tiruan tidak punya transaksi bersamaan: tiap event adalah satu transaksi
// yang langsung commit, jadi txid = seq sudah urut commit.
const cursorOf = (e) => `${e.seq}:${e.seq}`;
app.get('/sync/v2/start', async () => ({ after: `${seq + 1}:0`, server_time: new Date().toISOString() }));
app.get('/sync/v2/events', async (request, reply) => {
  const m = /^(\d+):(\d+)$/.exec(request.query.after ?? '0:0');
  if (!m) return reply.code(400).send({ message: 'after tidak valid' });
  const [tx, s] = [Number(m[1]), Number(m[2])];
  const limit = Math.min(Number(request.query.limit ?? 500), 1000);
  const rest = events.filter((e) => e.seq > tx || (e.seq === tx && e.seq > s));
  const page = rest.slice(0, limit).map((e) => ({ ...e, cursor: cursorOf(e) }));
  return { events: page, next_after: page.at(-1)?.cursor ?? `${tx}:${s}`, has_more: rest.length > limit,
    held_by_open_transaction: false, watermark: String(seq + 1), server_time: new Date().toISOString() };
});
for (const path of ['snapshot', 'checksum']) {
  app.get(`/sync/v2/${path}/:entity`, async (request, reply) => app.inject({ url: request.url.replace('/sync/v2/', '/sync/v1/'), headers: request.headers })
    .then((r) => reply.code(r.statusCode).send(r.json())));
}

app.get('/sync/v1/snapshot/:entity', async (request, reply) => {
  const map = store[request.params.entity];
  if (!map) return reply.code(404).send({ message: 'Entitas tidak dikenal' });
  const after = request.query.page_after_id ?? '';
  const limit = Math.min(Number(request.query.limit ?? 500), 1000);
  const ids = [...map.keys()].sort().filter((id) => id > after);
  const rows = ids.slice(0, limit).map((id) => ({ ...map.get(id).row, row_version: map.get(id).version }));
  return { rows, has_more: ids.length > limit, max_seq: seq };
});

app.get('/sync/v1/checksum/:entity', async (request, reply) => {
  const map = store[request.params.entity];
  if (!map) return reply.code(404).send({ message: 'Entitas tidak dikenal' });
  const ids = [...map.keys()].sort();
  const text = ids.map((id) => `${id}:${map.get(id).version}`).join(',');
  return { count: ids.length, hash: createHash('md5').update(text).digest('hex') };
});

app.put('/sync/v1/schedules/:id', async (request, reply) => {
  const prev = received.schedules.get(request.params.id);
  if (prev && prev.body.versi > request.body.versi) return reply.code(409).send({ message: 'Versi lebih lama' });
  const trackId = prev?.trackId ?? randomUUID();
  received.schedules.set(request.params.id, { trackId, body: request.body, idempotencyKey: request.headers['idempotency-key'] });
  return { data: { track_id: trackId } };
});

app.put('/sync/v1/payment-locks/:id', async (request, reply) => {
  if (!store.payments.has(request.params.id)) return reply.code(404).send({ message: 'Pembayaran tidak ditemukan' });
  received.locks.set(request.params.id, request.body);
  return { data: { locked: true } };
});

// ── Simulasi perubahan di Track (dev saja) ─────────────────
app.post('/_mock/:entity', async (request, reply) => {
  const map = store[request.params.entity];
  if (!map) return reply.code(404).send({ message: 'Entitas tidak dikenal' });
  const id = request.body.id ?? randomUUID();
  const prev = map.get(id);
  map.set(id, { row: { ...(prev?.row ?? {}), ...request.body, id }, version: (prev?.version ?? 0) + 1 });
  emit(request.params.entity, id, prev ? 'U' : 'I');
  return { id, version: map.get(id).version, seq };
});

app.delete('/_mock/:entity/:id', async (request, reply) => {
  const map = store[request.params.entity];
  if (!map?.has(request.params.id)) return reply.code(404).send({ message: 'Tidak ditemukan' });
  map.get(request.params.id).version += 1;
  emit(request.params.entity, request.params.id, 'D');
  map.delete(request.params.id);
  return { seq };
});

// Nomor seq terpakai tanpa event: transaksi Track yang di-rollback
app.post('/_mock/gap', async () => {
  seq += 1;
  return { seq };
});

// Ubah baris tanpa event: event terlewat, hanya rekonsiliasi yang bisa menangkap
app.post('/_mock/tanpa-event/:entity', async (request, reply) => {
  const map = store[request.params.entity];
  const item = map?.get(request.body.id);
  if (!item) return reply.code(404).send({ message: 'Tidak ditemukan' });
  item.row = { ...item.row, ...request.body };
  item.version += 1;
  return { version: item.version };
});

app.get('/_mock/diterima', async () => ({
  schedules: Object.fromEntries(received.schedules),
  locks: Object.fromEntries(received.locks),
  seq,
}));

if (!env.isDevelopment) {
  console.error('mock-track hanya untuk NODE_ENV=development');
  process.exit(1);
}
await boot();
const port = Number(process.env.MOCK_TRACK_PORT) || 3900;
await app.listen({ port, host: '127.0.0.1' });
console.log(`Track tiruan di http://127.0.0.1:${port} (${ENTITIES.map((e) => `${e} ${store[e].size}`).join(', ')})`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    await closeDatabase();
    process.exit(0);
  });
}

export { app };
