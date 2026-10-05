// ROLLBACK ONLY, owner approval required. Usage (root):
//   node --env-file=<file> restore.mjs <URL_VAR> <in.dump> [pg_restore args...]
// Connection details go through PG* environment variables, never argv or stdout.
import { spawnSync } from 'node:child_process';

const [varName, input, ...extra] = process.argv.slice(2);
if (process.env.PILOT_RESTORE_CONFIRM !== 'restore') {
  console.error('Set PILOT_RESTORE_CONFIRM=restore to run a restore');
  process.exit(1);
}
const u = new URL(process.env[varName]);
const env = {
  PATH: process.env.PATH, PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username),
  PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
  PGSSLMODE: u.searchParams.get('sslmode') || 'prefer', PGCONNECT_TIMEOUT: '15',
};
const r = spawnSync('/usr/lib/postgresql/16/bin/pg_restore', ['--no-owner', '--no-acl', '--single-transaction', '--exit-on-error',
  '-d', env.PGDATABASE, ...extra, input], { env, encoding: 'utf8' });
console.log(JSON.stringify({ status: r.status, stderr: (r.stderr || '').replace(/password[^\s]*/gi, '<redacted>').slice(0, 500) }));
process.exit(r.status ?? 1);
