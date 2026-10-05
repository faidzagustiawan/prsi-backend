// Track STAGING fixture mutations for the PRSI pilot. Root only, migration role,
// guarded by the staging identity marker. Never points at the Track source DB.
import { readFileSync } from 'node:fs';
import { connectStaging } from '../staging/guard.js';

const scenario = process.argv[2];
const id = (n) => `0e2e0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const FX = {
  company: id(1), prj1: id(11), prj2: id(12), cl1: id(21), cl2: id(22), u1: id(31), u2: id(32), u3: id(33),
  c1: id(41), a1: id(51), a2: id(52), p1: id(61), p2: id(62), p3: id(63), gapCompany: id(91), bench: id(99),
};
const ALL = Object.values(FX);

const instance = readFileSync('/etc/prtrack-staging/instance-id', 'utf8').trim();
if (process.env.PILOT_CONFIRM !== instance || process.env.STAGING_INSTANCE_ID !== instance) {
  console.error(JSON.stringify({ failed: true, reason: 'staging confirmation mismatch' }));
  process.exit(1);
}
const db = await connectStaging(process.env, { ready: true });

async function fixtureState() {
  const q = (t, cols) => db.unsafe(`SELECT ${cols}, sync_version::text FROM public.${t} WHERE id::text = ANY($1) ORDER BY id`, [ALL]);
  return {
    companies: await q('companies', 'id, nama_pt, alamat'),
    projects: await q('projects', 'id, status::text'),
    clusters: await q('clusters', 'id, project_id'),
    units: await q('units', 'id, status_pembangunan::text'),
    users: await q('users', 'id, role::text, nama, nomor_telepon'),
    assignments: await q('property_assignments', 'id, total_dibayar::text'),
    payments: await q('payment_history', 'id, jumlah_bayar::text, status_verifikasi'),
  };
}
const maxSeq = async () => Number((await db`SELECT coalesce(max(seq),0)::bigint AS s FROM public.sync_outbox`)[0].s);
const seqLast = async () => Number((await db`SELECT last_value::bigint AS s FROM public.sync_outbox_seq_seq`)[0].s);

const steps = {
  async A() {
    await db.begin(async (t) => {
      await t`INSERT INTO companies (id, nama_pt, kode_pt, alamat) VALUES (${FX.company}, 'PT Pilot E2E', 'E2E', 'Jl. Pilot 1')`;
      await t`INSERT INTO projects (id, company_id, nama_proyek, lokasi, status) VALUES
        (${FX.prj1}, ${FX.company}, 'Proyek Pilot E2E 1', 'Lokasi pilot', 'active'),
        (${FX.prj2}, ${FX.company}, 'Proyek Pilot E2E 2', 'Lokasi pilot', 'active')`;
      await t`INSERT INTO clusters (id, project_id, nama_cluster) VALUES (${FX.cl1}, ${FX.prj1}, 'Cluster E2E 1'), (${FX.cl2}, ${FX.prj2}, 'Cluster E2E 2')`;
      await t`INSERT INTO units (id, cluster_id, nomor_unit, tipe_rumah, luas_tanah, luas_bangunan) VALUES
        (${FX.u1}, ${FX.cl1}, 'E2E-01', '36/72', 72, 36), (${FX.u2}, ${FX.cl1}, 'E2E-02', '45/90', 90, 45),
        (${FX.u3}, ${FX.cl2}, 'E2E-03', '36/72', 72, 36)`;
      await t`INSERT INTO users (id, company_id, nama, email, password_hash, nomor_telepon, role, status, wa_notifications_enabled)
        VALUES (${FX.c1}, ${FX.company}, 'Customer Pilot E2E', 'e2e-c1@example.invalid', '!pilot-no-login', '080000000001', 'customer', 'inactive', false)`;
      await t`INSERT INTO property_assignments (id, user_id, unit_id, tanggal_pembelian, tipe_pembayaran, harga_total, dp) VALUES
        (${FX.a1}, ${FX.c1}, ${FX.u1}, '2026-10-05', 'cash_cicil', 500000000, 50000000),
        (${FX.a2}, ${FX.c1}, ${FX.u2}, '2026-10-05', 'kredit_kpr', 650000000, 65000000)`;
      await t`INSERT INTO payment_history (id, assignment_id, jumlah_bayar, tanggal_bayar, catatan, jenis, status_verifikasi) VALUES
        (${FX.p1}, ${FX.a1}, 10000000, '2026-10-05', 'pilot e2e', 'booking_fee', 'menunggu'),
        (${FX.p2}, ${FX.a1}, 40000000, '2026-10-05', 'pilot e2e', 'uang_muka', 'menunggu'),
        (${FX.p3}, ${FX.a2}, 15000000, '2026-10-05', 'pilot e2e', 'booking_fee', 'menunggu')`;
    });
  },
  async B() {
    await db.begin(async (t) => {
      await t`UPDATE companies SET nama_pt = 'PT Pilot E2E Berubah', alamat = 'Jl. Pilot 2 (diubah)' WHERE id = ${FX.company}`;
      await t`UPDATE projects SET status = 'on_hold' WHERE id = ${FX.prj1}`;
      await t`UPDATE units SET status_pembangunan = 'dalam_pembangunan' WHERE id = ${FX.u1}`;
      await t`UPDATE users SET nama = 'Customer Pilot E2E Diubah', nomor_telepon = '080000000002' WHERE id = ${FX.c1}`;
    });
  },
  async C() {
    // Three separate committed transactions: direct delete, cascade via assignment, cascade via parent project.
    await db`DELETE FROM payment_history WHERE id = ${FX.p1}`;
    await db`DELETE FROM property_assignments WHERE id = ${FX.a1}`; // cascades payment p2
    await db`DELETE FROM projects WHERE id = ${FX.prj2}`; // cascades cluster cl2 and unit u3
  },
  async D_out() { await db`UPDATE users SET role = 'admin' WHERE id = ${FX.c1}`; },
  async D_in() { await db`UPDATE users SET role = 'customer' WHERE id = ${FX.c1}`; },
  async F() {
    // Rolled-back transaction consumes an outbox seq: the gap described in TrackSyncAPI.md.
    await db.begin(async (t) => {
      await t`INSERT INTO companies (id, nama_pt, kode_pt, alamat) VALUES (${FX.gapCompany}, 'PT Gap Rollback', 'GAP', '-')`;
      throw Object.assign(new Error('intentional rollback'), { intentional: true });
    }).catch((e) => { if (!e.intentional) throw e; });
    await db`UPDATE companies SET alamat = 'Jl. Pilot 3 (setelah gap)' WHERE id = ${FX.company}`;
  },
  async cleanup() {
    await db.begin(async (t) => {
      await t`DELETE FROM property_assignments WHERE id IN (${FX.a1}, ${FX.a2})`;
      await t`DELETE FROM projects WHERE id IN (${FX.prj1}, ${FX.prj2})`;
      await t`DELETE FROM users WHERE id = ${FX.c1}`;
      await t`DELETE FROM companies WHERE id IN (${FX.company}, ${FX.gapCompany})`;
    });
  },
  async bench() {
    // N separate committed transactions on one bench company: N events for throughput measurement.
    const n = Number(process.env.PILOT_BENCH_N || 500);
    await db`INSERT INTO companies (id, nama_pt, kode_pt, alamat) VALUES (${FX.bench}, 'PT Bench E2E', 'BENCH', '0') ON CONFLICT (id) DO NOTHING`;
    for (let i = 1; i <= n; i += 1) await db`UPDATE companies SET alamat = ${String(i)} WHERE id = ${FX.bench}`;
  },
  async bench_cleanup() { await db`DELETE FROM companies WHERE id = ${FX.bench}`; },
  async inspect() {},
};

try {
  if (!steps[scenario]) throw new Error('unknown scenario');
  const before = { maxSeq: await maxSeq(), seqLastValue: await seqLast(), fixtures: await fixtureState() };
  const started = new Date();
  await steps[scenario]();
  const after = { maxSeq: await maxSeq(), seqLastValue: await seqLast(), fixtures: await fixtureState() };
  const events = scenario === 'bench' ? [] : await db`SELECT seq::int, entity, entity_id::text, op, row_version::text, created_at
    FROM public.sync_outbox WHERE seq > ${before.maxSeq} ORDER BY seq`;
  const [{ server }] = await db`SELECT current_database() || '@' || inet_server_port() AS server`;
  console.log(JSON.stringify({ scenario, server, started, finished: new Date(), before, after, newEvents: events,
    missingSeqs: events.length ? Array.from({ length: events.at(-1).seq - before.maxSeq }, (_, i) => before.maxSeq + 1 + i)
      .filter((s) => !events.some((e) => e.seq === s)) : [] }));
} catch (e) {
  console.error(JSON.stringify({ failed: true, scenario, error: e.message.slice(0, 200), code: e.code || null }));
  process.exitCode = 1;
} finally { await db.end(); }
