// src/config/dbGuard.js
import { sql } from 'drizzle-orm';

/**
 * Pemeriksaan isolasi saat server start.
 *
 * Kalau role database yang dipakai SI ternyata bisa membaca/menulis tabel Track
 * (misalnya DATABASE_URL tidak sengaja memakai neondb_owner), server menolak
 * berjalan. Ini jaring terakhir di atas grant database: konfigurasi yang salah
 * berhenti di sini, bukan berakhir menyentuh data Track.
 *
 * Lihat docs/DatabaseIsolation.md
 */
export async function assertIsolatedRole(database, { allowUnsafe = false, label = 'DATABASE_URL' } = {}) {
  const [identity] = await database.execute(sql`
    SELECT current_user AS role,
           has_schema_privilege('public', 'CREATE') AS can_create_public,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser
  `);

  const exposed = await database.execute(sql`
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v', 'm')
      AND (
        has_table_privilege(c.oid, 'SELECT')
        OR has_table_privilege(c.oid, 'INSERT')
        OR has_table_privilege(c.oid, 'UPDATE')
        OR has_table_privilege(c.oid, 'DELETE')
        OR has_table_privilege(c.oid, 'TRUNCATE')
      )
    ORDER BY c.relname
    LIMIT 20
  `);

  const problems = [];
  if (identity.is_superuser) problems.push('role adalah superuser');
  if (identity.can_create_public) problems.push('role bisa CREATE di schema public');
  if (exposed.length) {
    problems.push(`role bisa mengakses tabel Track: ${exposed.map((r) => r.table_name).join(', ')}`);
  }

  if (!problems.length) {
    return { role: identity.role, isolated: true };
  }

  const message =
    `[dbGuard] ${label} memakai role "${identity.role}" yang tidak terisolasi dari Track:\n` +
    problems.map((p) => `  - ${p}`).join('\n') +
    `\nGunakan role si_app / si_report (lihat database/setup).`;

  if (allowUnsafe) {
    console.warn(`${message}\n[dbGuard] ALLOW_UNSAFE_DB_ROLE aktif (development) - tetap dijalankan.`);
    return { role: identity.role, isolated: false };
  }

  throw new Error(message);
}
