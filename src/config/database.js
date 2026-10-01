// src/config/database.js
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { env } from './env.js';

// Pool kecil: SI berbagi database (dan batas koneksi Neon) dengan Track.
// Role si_app juga dibatasi CONNECTION LIMIT di sisi database.
const client = postgres(env.databaseUrl, {
  prepare: false, // wajib jika pakai Neon transaction pool
  max: 5,
  idle_timeout: 20,
  connect_timeout: 10,
});

// Koneksi laporan (role si_report, idealnya di read replica Neon) supaya query
// berat tidak memakai compute primary yang melayani Track.
const reportClient =
  env.reportDatabaseUrl === env.databaseUrl
    ? client
    : postgres(env.reportDatabaseUrl, {
        prepare: false,
        max: 3,
        idle_timeout: 20,
        connect_timeout: 10,
      });

export const db = drizzle(client);
export const reportDb = drizzle(reportClient);

export async function closeDatabase() {
  await client.end();
  if (reportClient !== client) await reportClient.end();
}

export { client, reportClient };
