import { readFile } from 'node:fs/promises';
import { collectInvariants } from './invariants.js';
import { gauge } from './metrics.js';
import { FIELDS } from './checksum.js';

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
        return { invariants, ...state };
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
      // Local cursor age cannot measure source lag. The independent checker owns
      // lag and mismatch metrics once the source checksum contract is available.
      output += gauge('sync_cursor_lag_seconds', null);
      for (const entity of Object.keys(FIELDS)) output += gauge('sync_reconcile_mismatch_total', null, `{entity="${entity}"}`);
      return output;
    },
  };
}
