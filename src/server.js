// src/server.js
import { env } from './config/env.js';
import { db, reportDb, reportClient, client, closeDatabase } from './config/database.js';
import { assertIsolatedRole } from './config/dbGuard.js';
import { buildApp } from './app.js';

const start = async () => {
  try {
    // Server menolak berjalan kalau role database bisa menyentuh tabel Track
    const runtime = await assertIsolatedRole(db, { allowUnsafe: env.allowUnsafeDbRole, label: 'DATABASE_URL' });
    console.log(`Database connected as "${runtime.role}" (isolated: ${runtime.isolated})`);

    if (reportClient !== client) {
      const report = await assertIsolatedRole(reportDb, { allowUnsafe: env.allowUnsafeDbRole, label: 'REPORT_DATABASE_URL' });
      console.log(`Report database connected as "${report.role}" (isolated: ${report.isolated})`);
    }

    const app = await buildApp();

    // Default loopback: reverse proxy (nginx) yang memegang 80/443.
    // Set HOST=0.0.0.0 hanya bila berjalan di dalam container.
    await app.listen({ port: env.port, host: env.host });

    const shutdown = async (signal) => {
      console.log(`${signal} received. Shutting down...`);
      try {
        await app.close();
        await closeDatabase();
      } catch (err) {
        console.error('Error during shutdown:', err);
      }
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    console.error('Failed to start application');
    console.error(err.message ?? err);
    await closeDatabase().catch(() => {});
    process.exit(1);
  }
};

start();
