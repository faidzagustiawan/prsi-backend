// src/config/database.js
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { env } from './env.js';

// Koneksi utama API. Boleh lewat transaction pooler (PgBouncer mode
// transaction): prepare dimatikan karena prepared statement tidak bertahan
// antar transaksi di pooler. Role si_app juga dibatasi CONNECTION LIMIT.
const client = postgres(env.databaseUrl, {
  prepare: false,
  max: env.dbPoolMax,
  idle_timeout: 20,
  connect_timeout: 10,
});

// Koneksi laporan (role si_report, read-only) supaya query berat tidak
// berebut pool dengan request biasa.
const reportClient =
  env.reportDatabaseUrl === env.databaseUrl
    ? client
    : postgres(env.reportDatabaseUrl, {
        prepare: false,
        max: 3,
        idle_timeout: 20,
        connect_timeout: 10,
      });

// Koneksi sesi untuk advisory lock worker sinkronisasi. Lock sesi harus tetap
// di koneksi server yang sama selama satu putaran, jadi tidak boleh lewat
// transaction pooler: pakai session pooler atau koneksi langsung.
const sessionClient =
  env.sessionDatabaseUrl === env.databaseUrl
    ? client
    : postgres(env.sessionDatabaseUrl, {
        prepare: false,
        max: 2,
        idle_timeout: 60,
        connect_timeout: 10,
      });

export const db = drizzle(client);
export const reportDb = drizzle(reportClient);

export async function closeDatabase() {
  await client.end();
  if (reportClient !== client) await reportClient.end();
  if (sessionClient !== client) await sessionClient.end();
}

export { client, reportClient, sessionClient };
