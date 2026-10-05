// One-shot PRSI pilot runner. Not a service. Prints evidence JSON without secrets.
import { mkdir, writeFile } from 'node:fs/promises';
import { env } from '../src/config/env.js';
import { db, client, closeDatabase } from '../src/config/database.js';
import { assertIsolatedRole } from '../src/config/dbGuard.js';

const mode = process.argv[2] || 'status';
const label = (process.env.PILOT_LABEL || mode).replace(/[^a-zA-Z0-9_.-]/g, '_');
const TABLES = { companies: 'trk_companies', projects: 'trk_projects', clusters: 'trk_clusters', units: 'trk_units',
  customers: 'trk_customers', assignments: 'trk_assignments', payments: 'trk_payments' };

// All HTTP must be GET to the staging loopback API. PUT or any other target is refused before leaving the process.
const audit = { requests: 0, byMethod: {}, put: 0, blocked: 0, paths: {}, statuses: {} };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  audit.byMethod[method] = (audit.byMethod[method] || 0) + 1;
  if (method === 'PUT') audit.put += 1;
  if (method !== 'GET' || url.origin !== 'http://127.0.0.1:3201' || !/^\/sync\/v[12]\//.test(url.pathname)) {
    audit.blocked += 1;
    throw new Error('Pilot outbound request rejected');
  }
  audit.requests += 1;
  const key = url.pathname.split('/').slice(0, 4).join('/');
  audit.paths[key] = (audit.paths[key] || 0) + 1;
  const res = await realFetch(input, { ...init, redirect: 'error' });
  audit.statuses[res.status] = (audit.statuses[res.status] || 0) + 1;
  return res;
};

function assertPilotConfig() {
  const bad = [];
  if (env.nodeEnv !== 'development') bad.push('NODE_ENV');
  if (process.env.ALLOW_UNSAFE_DB_ROLE !== 'false' || env.allowUnsafeDbRole) bad.push('ALLOW_UNSAFE_DB_ROLE');
  if (env.sync.writeEnabled || process.env.SYNC_WRITE_ENABLED !== 'false') bad.push('SYNC_WRITE_ENABLED');
  if (env.sync.scheduleToken) bad.push('TRACK_SCHEDULE_TOKEN');
  if (env.sync.enabled) bad.push('SYNC_ENABLED must stay false in persisted config');
  if (env.sync.trackApiUrl !== 'http://127.0.0.1:3201') bad.push('TRACK_API_URL');
  if (!env.sync.readToken) bad.push('TRACK_SYNC_TOKEN');
  if (bad.length) throw new Error(`Pilot configuration rejected: ${bad.join(', ')}`);
}

async function snapshotState(track) {
  const [cursor] = await client`SELECT cursor_seq::text AS cursor_seq, cursor_txid::text AS cursor_txid, gap_seq::text AS gap_seq, gap_since
    FROM finance.sync_cursor WHERE id='global'`;
  const [errs] = await client`SELECT count(*) FILTER (WHERE resolved_at IS NULL)::int AS unresolved, count(*)::int AS total FROM finance.sync_error`;
  const openErrors = await client`SELECT entity, entity_track_id::text AS track_id, seq::text, left(alasan,160) AS alasan, percobaan
    FROM finance.sync_error WHERE resolved_at IS NULL ORDER BY created_at LIMIT 10`;
  const tables = {};
  for (const [e, t] of Object.entries(TABLES)) {
    const [r] = await client.unsafe(`SELECT count(*)::int total, count(*) FILTER (WHERE NOT is_deleted)::int live,
      count(*) FILTER (WHERE is_deleted)::int deleted, coalesce(max(row_version),0)::text max_row_version,
      count(DISTINCT track_id)::int distinct_track_ids FROM finance.${t}`);
    tables[e] = r;
  }
  const [jurnal] = await client`SELECT count(*)::int AS jurnal, (SELECT count(*)::int FROM finance.jurnal_detail) AS jurnal_detail,
    (SELECT count(*)::int FROM finance.status_pembayaran_si) AS status_pembayaran_si FROM finance.jurnal`;
  const outbox = await client`SELECT status, count(*)::int n FROM finance.outbox_track GROUP BY 1 ORDER BY 1`;
  const lastLog = await client`SELECT entitas, arah, status, jml_baru, jml_ubah, jml_gagal, left(pesan,200) pesan, mulai, selesai
    FROM finance.sync_log ORDER BY mulai DESC LIMIT 2`;
  const fixtures = [];
  const ids = (process.env.PILOT_FIXTURES || '').split(',').filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  if (ids.length) {
    for (const [e, t] of Object.entries(TABLES)) {
      const rows = await client.unsafe(`SELECT track_id::text, row_version::text, is_deleted, track_seq::text,
        raw->>'nama_pt' nama_pt, raw->>'alamat' alamat, raw->>'status' status, raw->>'status_pembangunan' status_pembangunan,
        raw->>'nama' nama, raw->>'nomor_telepon' nomor_telepon, raw->>'jumlah_bayar' jumlah_bayar
        FROM finance.${t} WHERE track_id::text = ANY($1) ORDER BY track_id`, [ids]);
      for (const r of rows) fixtures.push({ entity: e, ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)) });
    }
  }
  const checksums = {};
  if (track) {
    const { localChecksum } = await import('../src/sync/reconcile.js');
    const { ENTITY_ORDER } = await import('../src/sync/mapping.js');
    for (const e of ENTITY_ORDER) {
      const remote = await track.checksum(e);
      const local = await localChecksum(e);
      checksums[e] = { trackCount: remote.count, prsiCount: local.count, trackHash: remote.hash, prsiHash: local.hash,
        match: remote.count === local.count && remote.hash === local.hash };
    }
  }
  return { cursor, syncError: errs, openErrors, tables, jurnal, outbox, lastLog, fixtures, checksums };
}

const evidence = { label, mode, time: new Date().toISOString(), protocol: env.sync.protocol, gapTimeoutSec: env.sync.gapTimeoutSec };
try {
  assertPilotConfig();
  const [id] = await client`SELECT current_database() AS database`;
  evidence.identity = { ...id, dbGuard: await assertIsolatedRole(db, { allowUnsafe: false, label: 'PRSI pilot' }) };
  const { createTrackClient } = await import('../src/sync/track-client.js');
  if (mode === 'migrate') {
    // Additive migrations only (scripts/check-migrations.js guards the folder). Sync stays off.
    if (process.env.PILOT_CONFIRM !== 'prsi-pilot-e2e') throw new Error('Explicit pilot confirmation required');
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    await migrate(db, { migrationsFolder: './drizzle', migrationsSchema: 'finance', migrationsTable: '__drizzle_migrations' });
    const cols = await client`SELECT column_name FROM information_schema.columns WHERE table_schema='finance' AND table_name='sync_cursor' ORDER BY ordinal_position`;
    evidence.migrated = cols.map((c) => c.column_name);
  } else if (mode === 'status') {
    evidence.state = await snapshotState(createTrackClient());
  } else if (mode === 'cycle' || mode === 'reconcile') {
    if (process.env.PILOT_CONFIRM !== 'prsi-pilot-e2e') throw new Error('Explicit pilot confirmation required');
    evidence.before = await snapshotState(null);
    const { runCycle, runReconcile } = await import('../src/sync/runner.js');
    // Persisted configuration stays SYNC_ENABLED=false; enabled only inside this one-shot process.
    env.sync.enabled = true;
    const started = Date.now();
    const r = mode === 'cycle' ? await runCycle() : await runReconcile();
    env.sync.enabled = false;
    evidence.durationMs = Date.now() - started;
    evidence.result = r.dilewati ? r : mode === 'cycle'
      ? { tarik: { status: r.tarik.status, pesan: r.tarik.pesan, counts: r.tarik.counts, result: r.tarik.result },
        pembayaran: r.pembayaran, kirim: { status: r.kirim.status, pesan: r.kirim.pesan } }
      : { status: r.status, pesan: r.pesan, counts: r.counts, result: r.result };
    evidence.after = await snapshotState(createTrackClient());
  } else if (mode === 'rewind') {
    // v2 replay through the real worker path: move the cursor back, run one cycle, nothing may change.
    if (process.env.PILOT_CONFIRM !== 'prsi-pilot-e2e' || env.sync.protocol !== 'v2') throw new Error('Explicit pilot confirmation required');
    const m = /^(\d+):(\d+)$/.exec(process.env.PILOT_REPLAY_AFTER_SEQ || '');
    if (!m) throw new Error('Pilot replay start required');
    evidence.before = await snapshotState(createTrackClient());
    await client`UPDATE finance.sync_cursor SET cursor_txid = ${Number(m[1])}, cursor_seq = ${Number(m[2])}, updated_at = now() WHERE id = 'global'`;
    const { runCycle } = await import('../src/sync/runner.js');
    env.sync.enabled = true;
    const r = await runCycle();
    env.sync.enabled = false;
    evidence.result = { rewoundTo: m[0], tarik: { status: r.tarik.status, counts: r.tarik.counts, result: r.tarik.result }, pembayaran: r.pembayaran };
    evidence.after = await snapshotState(createTrackClient());
    evidence.unchanged = JSON.stringify(evidence.before.tables) === JSON.stringify(evidence.after.tables)
      && JSON.stringify(evidence.before.fixtures) === JSON.stringify(evidence.after.fixtures)
      && evidence.before.cursor.cursor_seq === evidence.after.cursor.cursor_seq;
  } else if (mode === 'replay') {
    // Re-apply already applied events without moving the cursor. Every one must be ignored.
    if (process.env.PILOT_CONFIRM !== 'prsi-pilot-e2e') throw new Error('Explicit pilot confirmation required');
    const from = Number(process.env.PILOT_REPLAY_AFTER_SEQ);
    if (!Number.isSafeInteger(from)) throw new Error('Pilot replay start required');
    evidence.before = await snapshotState(null);
    const { applyChange } = await import('../src/sync/apply.js');
    const track = createTrackClient();
    const res = await track.events(from, 1000);
    const outcome = {};
    for (const e of res.events) {
      if (e.seq > Number(evidence.before.cursor.cursor_seq)) break; // only events already applied
      const r = await db.transaction((tx) => applyChange(tx, { entity: e.entity, trackId: e.entity_id, op: e.op,
        rowVersion: e.row_version, seq: e.seq, payload: e.payload }));
      outcome[r] = (outcome[r] || 0) + 1;
    }
    evidence.result = { replayedAfterSeq: from, events: res.events.length, outcome };
    evidence.after = await snapshotState(track);
  } else throw new Error('Unknown pilot mode');
  evidence.network = audit;
  const dir = '/var/lib/prsi-pilot-e2e/evidence';
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(`${dir}/${label}.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(evidence));
} catch (error) {
  // Never print driver errors verbatim: they may carry connection details.
  const safe = /^(Pilot|Explicit|Unknown|Sinkronisasi|Bentuk|Event)/.test(error.message) ? error.message.slice(0, 300) : null;
  console.error(JSON.stringify({ failed: true, label, mode, errorType: error.name, code: error.code || null, message: safe, network: audit }));
  process.exitCode = 1;
} finally { await closeDatabase(); }
