// src/config/database.js
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { env } from './env.js';

// Koneksi utama API. Boleh lewat transaction pooler (PgBouncer mode
// transaction): prepare dimatikan karena prepared statement tidak bertahan
// antar transaksi di pooler. Role si_app juga dibatasi CONNECTION LIMIT.
// Supavisor/PgBouncer mode transaksi: query yang dipipeline dalam satu koneksi bisa terpotong
// saat beban serentak, lalu server menunggu klien (ClientRead) dan koneksi tergantung selamanya.
// Satu query per koneksi pada satu waktu mencegahnya.
const POOLER_SAFE = { max_pipeline: 1 };

const client = postgres(env.databaseUrl, {
  ...POOLER_SAFE,
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
        ...POOLER_SAFE,
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
        ...POOLER_SAFE,
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
