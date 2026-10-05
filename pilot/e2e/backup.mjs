// Usage (root): node --env-file=<file> backup.mjs <URL_VAR> <out.dump> [pg_dump args...]
// Connection details go through PG* environment variables, never argv or stdout.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const [varName, out, ...extra] = process.argv.slice(2);
const u = new URL(process.env[varName]);
const bin = '/usr/lib/postgresql/16/bin';
const env = {
  PATH: process.env.PATH, PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username),
  PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: decodeURIComponent(u.pathname.slice(1)),
  PGSSLMODE: u.searchParams.get('sslmode') || 'prefer', PGCONNECT_TIMEOUT: '15',
};
const r = spawnSync(`${bin}/pg_dump`, ['-Fc', '--no-owner', '--no-acl', '--lock-wait-timeout=5000', '-f', out, ...extra], { env, encoding: 'utf8' });
if (r.status !== 0) {
  console.error(JSON.stringify({ failed: true, status: r.status, stderr: (r.stderr || '').replace(/password[^\s]*/gi, '<redacted>').slice(0, 300) }));
  process.exit(1);
}
const list = spawnSync(`${bin}/pg_restore`, ['-l', out], { encoding: 'utf8' });
const toc = list.stdout.split('\n');
console.log(JSON.stringify({
  file: out, bytes: statSync(out).size, sha256: createHash('sha256').update(readFileSync(out)).digest('hex'),
  tableData: toc.filter((l) => l.includes('TABLE DATA')).length, tocEntries: toc.filter((l) => /^\d+;/.test(l)).length,
}));
