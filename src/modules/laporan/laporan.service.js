// src/modules/laporan/laporan.service.js
import { sql } from 'drizzle-orm';
import { reportDb } from '../../config/database.js';
import { STATUS_TERBUKU } from '../jurnal/jurnal.repository.js';

const terbuku = sql.raw(STATUS_TERBUKU.map((s) => `'${s}'`).join(', '));
const n = (v) => Number(v ?? 0);

export const nextMonth = (bulan) => {
  const [y, m] = bulan.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};

/**
 * Saldo per kode pembantu untuk satu bulan (FE: getSaldoPerKodePembantu).
 * Gerak bertanda menurut saldo normal akun barisnya, jadi hutang positif bila
 * kredit > debit dan piutang positif bila debit > kredit.
 *
 * kategori: daftar kategori kode pembantu yang disertakan (opsional).
 * akunKategori: batasi ke baris akun berkategori tertentu, mis. 'hutang'.
 */
export async function saldoKodePembantu({ bulan, proyekId, kategori, akunKategori }) {
  const start = `${bulan}-01`;
  const end = nextMonth(bulan);
  const filters = [
    proyekId ? sql`AND kp.proyek_id = ${proyekId}` : sql``,
    kategori?.length ? sql`AND kp.kategori IN (${sql.join(kategori.map((k) => sql`${k}`), sql`, `)})` : sql``,
  ];
  const akunFilter = akunKategori ? sql`AND a.kategori = ${akunKategori}` : sql``;
  // Dengan akunKategori, kode pembantu yang hanya dipakai di sisi lain (mis.
  // piutang antar proyek di proyek pemberi) tidak ikut ditampilkan.
  const sisiLain = akunKategori
    ? sql`AND NOT EXISTS (
        SELECT 1 FROM finance.jurnal_detail x JOIN finance.akun xa ON xa.id = x.akun_id
        WHERE x.kode_pembantu_id = kp.id AND xa.kategori_hp_id IS NOT NULL AND xa.kategori <> ${akunKategori})`
    : sql``;

  const rows = await reportDb.execute(sql`
    WITH gerak AS (
      SELECT s.kode_pembantu_id kp_id, DATE '0001-01-01' tanggal, s.debit d, s.kredit k, a.tipe_saldo
      FROM finance.saldo_awal s JOIN finance.akun a ON a.id = s.akun_id
      WHERE s.kode_pembantu_id IS NOT NULL ${akunFilter}
      UNION ALL
      SELECT jd.kode_pembantu_id, j.tanggal, jd.debit, jd.kredit, a.tipe_saldo
      FROM finance.jurnal_detail jd JOIN finance.jurnal j ON j.id = jd.jurnal_id JOIN finance.akun a ON a.id = jd.akun_id
      WHERE jd.kode_pembantu_id IS NOT NULL AND j.status IN (${terbuku}) AND j.tanggal < ${end} ${akunFilter}
    )
    SELECT kp.id, kp.kode, kp.nama, kp.kategori, kp.proyek_id, kp.proyek_lawan_id, kp.aktif,
      COALESCE(SUM(CASE WHEN g.tanggal < ${start} THEN CASE WHEN g.tipe_saldo = 'k' THEN g.k - g.d ELSE g.d - g.k END END), 0) saldo_awal,
      COALESCE(SUM(CASE WHEN g.tanggal >= ${start} THEN g.d END), 0) total_debit,
      COALESCE(SUM(CASE WHEN g.tanggal >= ${start} THEN g.k END), 0) total_kredit,
      COALESCE(SUM(CASE WHEN g.tanggal >= ${start} THEN CASE WHEN g.tipe_saldo = 'k' THEN g.k - g.d ELSE g.d - g.k END END), 0) mutasi
    FROM finance.kode_pembantu kp
    LEFT JOIN gerak g ON g.kp_id = kp.id
    WHERE TRUE ${filters[0]} ${filters[1]} ${sisiLain}
    GROUP BY kp.id
    ORDER BY kp.kode
  `);

  return rows.map((r) => ({
    kodePembantu: {
      id: r.id, kode: r.kode, nama: r.nama, kategori: r.kategori, proyekId: r.proyek_id,
      proyekLawanId: r.proyek_lawan_id, aktif: r.aktif,
    },
    saldoAwal: n(r.saldo_awal),
    totalDebit: n(r.total_debit),
    totalKredit: n(r.total_kredit),
    mutasiBulan: n(r.mutasi),
    saldoAkhir: Math.round((n(r.saldo_awal) + n(r.mutasi)) * 100) / 100,
  }));
}
