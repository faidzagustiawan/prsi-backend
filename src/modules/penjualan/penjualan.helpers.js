// src/modules/penjualan/penjualan.helpers.js
import { and, eq, sql } from 'drizzle-orm';
import { kodePembantu } from '../../shared/schemas/akuntansi.schema.js';
import { trkAssignments, trkCustomers, trkUnits } from '../../shared/schemas/track.schema.js';
import { AppError } from '../../shared/utils/AppError.js';
import { generateKode } from '../kode-pembantu/kode-pembantu.routes.js';
import { STATUS_TERBUKU } from '../jurnal/jurnal.repository.js';

const terbuku = sql.raw(STATUS_TERBUKU.map((s) => `'${s}'`).join(', '));

/** Penjualan Track beserta unit dan pembelinya. */
export async function findAssignment(tx, id) {
  const [row] = await tx
    .select({ a: trkAssignments, unit: trkUnits, customer: trkCustomers })
    .from(trkAssignments)
    .innerJoin(trkUnits, eq(trkUnits.id, trkAssignments.unitId))
    .innerJoin(trkCustomers, eq(trkCustomers.id, trkAssignments.customerId))
    .where(eq(trkAssignments.id, id))
    .limit(1);
  if (!row || row.a.isDeleted) throw new AppError('Penjualan (PR Track) tidak ditemukan.', 422);
  return row;
}

/** Kode pembantu pembeli untuk customer Track; dibuat otomatis bila belum ada. */
export async function kodePembantuPembeli(tx, customer, proyekId) {
  const [found] = await tx.select().from(kodePembantu)
    .where(and(eq(kodePembantu.kategori, 'pembeli'), eq(kodePembantu.customerId, customer.id))).limit(1);
  if (found) return found;
  const [created] = await tx.insert(kodePembantu).values({
    kode: await generateKode(tx, 'pembeli'), nama: customer.nama, kategori: 'pembeli', proyekId, customerId: customer.id,
  }).returning();
  return created;
}

/**
 * Saldo terbuku satu akun untuk satu kode pembantu di satu proyek, bertanda
 * menurut saldo normal akunnya, dalam sen.
 */
export async function saldoAkunKp(tx, { akunId, kodePembantuId, proyekId }) {
  const [row] = await tx.execute(sql`
    SELECT COALESCE(SUM(CASE WHEN a.tipe_saldo = 'k' THEN jd.kredit - jd.debit ELSE jd.debit - jd.kredit END), 0) saldo
    FROM finance.jurnal_detail jd
    JOIN finance.jurnal j ON j.id = jd.jurnal_id
    JOIN finance.akun a ON a.id = jd.akun_id
    WHERE jd.akun_id = ${akunId} AND jd.kode_pembantu_id = ${kodePembantuId}
      AND j.proyek_id = ${proyekId} AND j.status IN (${terbuku})
  `);
  return BigInt(Math.round(Number(row.saldo) * 100));
}

const lastDay = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/**
 * Jadwal bulanan dari tanggal mulai sampai jatuh tempo terakhir. Tanggal acuan
 * 29-31 di bulan yang lebih pendek jatuh ke akhir bulan (ERD Alur 3).
 */
export function hitungJadwal({ tanggalAcuan, nominalPerBulan, tanggalMulai, jatuhTempoTerakhir }) {
  const [sy, sm] = tanggalMulai.split('-').map(Number);
  const end = jatuhTempoTerakhir;
  const baris = [];
  for (let i = 0, y = sy, m = sm - 1; i < 600; i += 1) {
    const tanggal = `${y}-${String(m + 1).padStart(2, '0')}-${String(Math.min(tanggalAcuan, lastDay(y, m))).padStart(2, '0')}`;
    if (tanggal > end) break;
    if (tanggal >= tanggalMulai || i > 0) baris.push({ tanggal, jumlah: nominalPerBulan, keterangan: `DP ${baris.length + 1}` });
    m += 1;
    if (m === 12) { m = 0; y += 1; }
  }
  return baris;
}
