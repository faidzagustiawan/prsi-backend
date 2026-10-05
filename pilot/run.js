import { writeFile } from 'node:fs/promises';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, client, closeDatabase } from '../src/config/database.js';
import { env } from '../src/config/env.js';
import { runCycle, runReconcile } from '../src/sync/runner.js';
import { createTrackClient } from '../src/sync/track-client.js';
import { ENTITY_ORDER } from '../src/sync/mapping.js';
import { localChecksum } from '../src/sync/reconcile.js';
import { assertPilot, instrumentNetwork } from './guard.js';

const mode = process.argv[2] || 'verify';
const audit = instrumentNetwork();
try {
  const identity = await assertPilot();
  const evidence = { time: new Date().toISOString(), mode, identity, network: audit };
  if (mode === 'migrate') {
    if (env.sync.enabled) throw new Error('Disable sync before migration');
    await migrate(db, { migrationsFolder: './drizzle', migrationsSchema: 'finance' });
    evidence.migrated = true;
  } else if (['cycle', 'reconcile'].includes(mode)) {
    if (process.env.PILOT_CONFIRM !== process.env.PILOT_INSTANCE_ID) throw new Error('Explicit pilot confirmation required');
    // Persisted configuration stays disabled. Enable only this guarded one-shot process.
    env.sync.enabled = true;
    evidence.result = mode === 'cycle' ? await runCycle() : await runReconcile();
    evidence.entities = {};
    const track = createTrackClient();
    for (const entity of ENTITY_ORDER) {
      const remote = await track.checksum(entity), local = await localChecksum(entity);
      evidence.entities[entity] = { remote, local, match: JSON.stringify(remote) === JSON.stringify(local) };
    }
    const [errors] = await client`SELECT count(*)::int AS unresolved FROM finance.sync_error WHERE resolved_at IS NULL`;
    evidence.errors = errors;
    const [outbox] = await client`SELECT count(*)::int AS total FROM finance.outbox_track`;
    evidence.outbox = outbox;
    await writeFile(`/var/lib/prsi-pilot/evidence/${mode}.json`, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  } else if (mode !== 'verify') throw new Error('Unknown pilot operation');
  console.log(JSON.stringify(evidence));
} catch (error) {
  // Driver errors may contain connection details or SQL values. Keep logs generic.
  console.error(JSON.stringify({ failed: true, mode, errorType: error.name, code: error.code || null }));
  process.exitCode = 1;
} finally { await closeDatabase(); }
