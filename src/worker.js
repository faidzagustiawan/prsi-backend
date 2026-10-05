// src/worker.js
//
// Proses worker sinkronisasi PR Track, terpisah dari API:  npm run worker
// - Putaran tiap SYNC_INTERVAL_SEC: tarik event, proses pembayaran, kirim outbox.
// - Rekonsiliasi sekali sehari pada SYNC_RECONCILE_HOUR.
// - SYNC_ENABLED=false: worker tidak menghubungi Track (saklar darurat).
import { env } from './config/env.js';
import { closeDatabase } from './config/database.js';
import { runCycle, runReconcile } from './sync/runner.js';
import { assertConfig } from './sync/track-client.js';

const log = (...args) => console.log(new Date().toISOString(), ...args);
let stopping = false;
let timer = null;
let lastReconcileDay = null;

const ringkas = (r) => {
  if (r.dilewati) return `dilewati: ${r.alasan}`;
  const t = r.tarik;
  return `tarik ${t.status} (baru ${t.counts.baru}, ubah ${t.counts.ubah}, gagal ${t.counts.gagal}, cursor ${t.result?.cursor ?? '-'})`
    + ` | pembayaran ${JSON.stringify(r.pembayaran)} | kirim ${r.kirim.status} (${r.kirim.counts.terkirim} terkirim, ${r.kirim.counts.gagalKirim} gagal)`;
};

// Ada event di putaran ini: kemungkinan masih ada lanjutan, cek lagi lebih cepat.
// Sepi: kembali ke interval normal supaya Track (dan compute Neon-nya) tidak terus dibangunkan.
const nextDelaySec = (r, cfg = env.sync) => {
  const c = r?.tarik?.counts;
  const sibuk = c && (c.baru + c.ubah + c.gagal > 0);
  return sibuk ? Math.min(cfg.busyIntervalSec, cfg.intervalSec) : cfg.intervalSec;
};

async function tick() {
  if (stopping) return;
  let delaySec = env.sync.intervalSec;
  try {
    const r = await runCycle();
    delaySec = nextDelaySec(r);
    log('[sync]', ringkas(r));
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getHours() >= env.sync.reconcileHour && lastReconcileDay !== day) {
      const r = await runReconcile();
      lastReconcileDay = day;
      log('[rekonsiliasi]', r.dilewati ? r.alasan : JSON.stringify(r.result));
    }
  } catch (err) {
    log('[sync] galat:', err.message);
  } finally {
    if (!stopping) timer = setTimeout(tick, delaySec * 1000);
  }
}

async function shutdown(signal) {
  stopping = true;
  clearTimeout(timer);
  log(`${signal} diterima, worker berhenti.`);
  await closeDatabase().catch(() => {});
  process.exit(0);
}

if (!env.sync.enabled) {
  log('SYNC_ENABLED=false: worker tidak menghubungi PR Track. Keluar.');
  await closeDatabase();
  process.exit(0);
}
assertConfig();
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
log(`Worker sinkronisasi jalan: ${env.sync.trackApiUrl}, tiap ${env.sync.intervalSec} detik.`);
tick();
