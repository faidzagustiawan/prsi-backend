import { env } from '../src/config/env.js';
import { client, db } from '../src/config/database.js';
import { assertIsolatedRole } from '../src/config/dbGuard.js';

export async function assertPilot() {
  const url = new URL(env.databaseUrl);
  if (env.nodeEnv !== 'development' || process.env.ALLOW_UNSAFE_DB_ROLE !== 'false'
    || env.sync.writeEnabled || env.sync.scheduleToken || env.sync.trackApiUrl !== 'http://127.0.0.1:3201'
    || url.hostname !== '127.0.0.1' || url.port !== '55441' || url.pathname !== '/prsi_pilot'
    || decodeURIComponent(url.username) !== 'prsi_pilot' || url.search
    || env.reportDatabaseUrl !== env.databaseUrl || env.sessionDatabaseUrl !== env.databaseUrl) {
    throw new Error('Pilot configuration rejected');
  }
  const [identity] = await client`SELECT current_database() AS db, current_user AS role,
    inet_server_port() AS port, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid
    FROM pg_roles WHERE rolname=current_user`;
  const [marker] = await client`SELECT instance_id::text, database_oid::text FROM pilot_control.identity`;
  const memberships = await client`SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)`;
  const other = await client`SELECT 1 FROM pg_database WHERE datname<>current_database() AND datallowconn
    AND NOT datistemplate AND has_database_privilege(current_user,oid,'CONNECT')`;
  if (identity.db !== 'prsi_pilot' || identity.role !== 'prsi_pilot' || identity.port !== 55441
    || identity.rolsuper || identity.rolcreatedb || identity.rolcreaterole || identity.rolreplication || identity.rolbypassrls
    || memberships.length || other.length || !process.env.PILOT_INSTANCE_ID
    || marker.instance_id !== process.env.PILOT_INSTANCE_ID || marker.database_oid !== identity.oid) {
    throw new Error('Pilot database identity rejected');
  }
  await assertIsolatedRole(db, { allowUnsafe: false, label: 'PRSI pilot' });
  return { database: identity.db, role: identity.role, port: identity.port, instance: marker.instance_id, dbGuard: true };
}

// All worker HTTP must remain GET on the two explicitly approved loopback APIs.
// Record only methods/paths/status; never headers or response bodies.
export function instrumentNetwork() {
  const original = globalThis.fetch;
  const audit = { requests: 0, put: 0, blocked: 0, statuses: {} };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init.method || (input instanceof Request ? input.method : 'GET');
    if (method === 'PUT') audit.put++;
    if (method !== 'GET' || !['http://127.0.0.1:3201', 'http://127.0.0.1:3100'].includes(url.origin)
      || (url.port === '3100' && url.pathname !== '/health')) {
      audit.blocked++;
      throw new Error('Pilot outbound request rejected');
    }
    audit.requests++;
    const response = await original(input, { ...init, redirect: 'error' });
    audit.statuses[response.status] = (audit.statuses[response.status] || 0) + 1;
    return response;
  };
  return audit;
}
