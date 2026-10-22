import { readFile } from 'node:fs/promises';
import { collectInvariants } from './invariants.js';
import { gauge, labels } from './metrics.js';
import { FIELDS } from './checksum.js';

// Whitelists keep label values bounded even if the database holds unexpected text.
const DIRECTIONS = { tarik: 'pull', kirim: 'push', rekonsiliasi: 'reconcile', rekon_billing: 'reconcile_billing' };
const CYCLE_STATUSES = new Set(['sukses', 'gagal', 'beda', 'lewati']);
const PAYMENT_STATUSES = new Set(['belum_diproses', 'menunggu', 'dijurnal', 'historis', 'gagal_validasi', 'perlu_ditinjau', 'ditolak']);
const OUTBOX_STATUSES = new Set(['tertunda', 'gagal', 'terkirim']);
const pick = (set, value) => (set.has(value) ? value : 'lain');

export function createCollector(client, { now = () => Date.now(), backupFile = process.env.PRSI_BACKUP_TIMESTAMP_FILE } = {}) {
  let snapshot = null, successAt = null, successful = false, running = null;
  async function collect() {
    try {
      const next = await client.begin('isolation level repeatable read read only', async (tx) => {
        await tx`SET LOCAL statement_timeout = '10s'`;
        await tx`SET LOCAL TIME ZONE 'UTC'`;
        const invariants = await collectInvariants(tx);
        const [state] = await tx`SELECT
          (SELECT count(*)::int FROM finance.sync_error WHERE resolved_at IS NULL) AS errors,
          (SELECT count(*)::int FROM finance.outbox_track WHERE status='gagal') AS outbox,
          (SELECT extract(epoch FROM gap_since)::double precision FROM finance.sync_cursor WHERE id='global') AS held_since,
          (SELECT extract(epoch FROM max(selesai))::double precision FROM finance.sync_log WHERE arah='tarik' AND status='sukses') AS cycle_at`;
        // Worker counters come from finance.sync_log, which the worker writes every
        // cycle. Sums over the whole table behave as Prometheus counters.
        const syncLog = await tx`SELECT arah, status, count(*)::int AS cycles,
          coalesce(sum(jml_baru),0)::bigint AS baru, coalesce(sum(jml_ubah),0)::bigint AS ubah, coalesce(sum(jml_gagal),0)::bigint AS gagal,
          extract(epoch FROM max(selesai))::double precision AS last_at
          FROM finance.sync_log GROUP BY arah, status`;
        const payments = await tx`SELECT coalesce(s.status_proses,'belum_diproses') AS status, count(*)::int AS count
          FROM finance.trk_payments p LEFT JOIN finance.status_pembayaran_si s ON s.payment_id = p.id GROUP BY 1`;
        const outboxItems = await tx`SELECT status, count(*)::int AS count FROM finance.outbox_track GROUP BY status`;
        return { invariants, ...state, syncLog, payments, outboxItems };
      });
      next.backupAt = null;
      if (backupFile) {
        try {
          const value = Number((await readFile(backupFile, 'utf8')).trim());
          if (Number.isFinite(value) && value > 0 && value <= now() / 1000) next.backupAt = value;
        } catch { /* Missing backup evidence is unknown, never healthy. */ }
      }
      snapshot = next;
      successAt = now() / 1000;
      successful = true;
    } catch {
      // SQL errors can contain raw payloads; do not log them or return them.
      successful = false;
    }
  }
  return {
    refresh() {
      if (!running) running = collect().finally(() => { running = null; });
      return running;
    },
    render() {
      const time = now() / 1000;
      let output = gauge('monitor_collection_success', Number(successful))
        + gauge('monitor_collection_age_seconds', successAt === null ? null : time - successAt);
      if (!snapshot) return output;
      for (const [name, count] of Object.entries(snapshot.invariants)) output += gauge('accounting_invariant_violations', count, `{invariant="${name}"}`);
      output += gauge('sync_error_unresolved', snapshot.errors) + gauge('outbox_failed', snapshot.outbox)
        + gauge('sync_held_seconds', snapshot.held_since === null ? 0 : Math.max(0, time - snapshot.held_since))
        + gauge('sync_last_cycle_age_seconds', snapshot.cycle_at === null ? null : Math.max(0, time - snapshot.cycle_at))
        + gauge('backup_last_age_seconds', snapshot.backupAt === null ? null : time - snapshot.backupAt)
        + gauge('backup_timestamp_available', Number(snapshot.backupAt !== null));
      output += workerMetrics(snapshot);
      // Local cursor age cannot measure source lag. The independent checker owns
      // lag and mismatch metrics once the source checksum contract is available.
      output += gauge('sync_cursor_lag_seconds', null);
      for (const entity of Object.keys(FIELDS)) output += gauge('sync_reconcile_mismatch_total', null, `{entity="${entity}"}`);
      return output;
    },
  };
}

const add = (map, key, value) => map.set(key, (map.get(key) ?? 0) + Number(value ?? 0));

// Renders a Map whose keys are 'a|b' joined label values.
function series(name, type, map, labelNames) {
  let out = `# TYPE ${name} ${type}\n`;
  for (const [key, value] of map) {
    const parts = key.split('|');
    out += gauge(name, value, labels(Object.fromEntries(labelNames.map((n, i) => [n, parts[i]]))));
  }
  return out;
}

function backlog(rows, allowed) {
  const counts = new Map([...allowed].map((s) => [s, 0]));
  for (const r of rows) add(counts, pick(allowed, r.status), r.count);
  return counts;
}

export function workerMetrics({ syncLog = [], payments = [], outboxItems = [] }) {
  const cycles = new Map(), rows = new Map(), lastSuccess = new Map();
  for (const r of syncLog) {
    const direction = DIRECTIONS[r.arah] ?? 'lain';
    add(cycles, `${direction}|${pick(CYCLE_STATUSES, r.status)}`, r.cycles);
    add(rows, `${direction}|new`, r.baru);
    add(rows, `${direction}|updated`, r.ubah);
    add(rows, `${direction}|failed`, r.gagal);
    if (r.status === 'sukses' && r.last_at != null) lastSuccess.set(direction, Math.max(lastSuccess.get(direction) ?? 0, r.last_at));
  }
  return series('sync_cycles_total', 'counter', cycles, ['direction', 'status'])
    + series('sync_rows_total', 'counter', rows, ['direction', 'kind'])
    // Written by the worker itself, so time() - value stays accurate between collections.
    + series('sync_last_success_timestamp_seconds', 'gauge', lastSuccess, ['direction'])
    + series('payments_by_status', 'gauge', backlog(payments, PAYMENT_STATUSES), ['status'])
    + series('outbox_items', 'gauge', backlog(outboxItems, OUTBOX_STATUSES), ['status']);
}
