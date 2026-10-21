// Read-only activation checks. Never starts a worker or inserts a cursor.
import {env} from '../src/config/env.js';
import {client,db,closeDatabase} from '../src/config/database.js';
import {assertIsolatedRole} from '../src/config/dbGuard.js';
import {createTrackClient} from '../src/sync/track-client.js';
const report={gates:{sync:env.sync.enabled,write:env.sync.writeEnabled,billing:env.billingEnabled},checks:{}};
try {
 report.checks.isolated=(await assertIsolatedRole(db)).isolated;
 report.checks.protocol=env.sync.protocol==='v2';
 report.checks.sessionConnection=Boolean(process.env.SESSION_DATABASE_URL);
 report.checks.tokens=env.sync.readToken.length>=32 && env.sync.scheduleToken.length>=32 && env.sync.readToken!==env.sync.scheduleToken;
 const [columns]=await client`SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='finance' AND
  ((table_name='sync_cursor' AND column_name IN ('bootstrap','source_id')) OR (table_name='trk_payments' AND column_name='si_jadwal_id') OR (table_name='outbox_track' AND column_name='sequence') OR (table_name='status_pembayaran_si' AND column_name='keputusan'))`;
 report.checks.schema=columns.n===5;
 const start=await createTrackClient().startV2();
 report.checks.remoteContract=start.contract_version===2 && Boolean(start.source_id);
 const [cursor]=await client`SELECT source_id,bootstrap FROM finance.sync_cursor WHERE id='global'`;
 report.checks.sameSource=cursor?.source_id===start.source_id;
 report.checks.bootstrapComplete=Boolean(cursor?.source_id) && !cursor.bootstrap;
 report.sourceId=start.source_id;
 report.ready=Object.values(report.checks).every(Boolean);
} catch(error) {report.ready=false;report.error=error.name;}
finally {await closeDatabase();}
console.log(JSON.stringify(report,null,2));
if(!report.ready) process.exitCode=1;
