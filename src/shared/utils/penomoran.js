// src/shared/utils/penomoran.js
import { sql } from 'drizzle-orm';

/**
 * Nomor urut berikutnya untuk (jenis, scope, tahun, bulan).
 * Satu statement upsert: baris penomoran terkunci sampai transaksi pemanggil
 * selesai, jadi dua transaksi paralel tidak pernah mendapat nomor yang sama.
 * Wajib dipanggil di dalam transaksi yang menyimpan dokumennya, supaya nomor
 * yang batal dipakai ikut di-rollback.
 */
export async function nextNumber(tx, { jenis, scope = '', tahun, bulan = 0 }) {
  const [row] = await tx.execute(sql`
    INSERT INTO finance.penomoran (jenis, scope, tahun, bulan, nomor_terakhir)
    VALUES (${jenis}, ${scope}, ${tahun}, ${bulan}, 1)
    ON CONFLICT (jenis, scope, tahun, bulan)
    DO UPDATE SET nomor_terakhir = finance.penomoran.nomor_terakhir + 1
    RETURNING nomor_terakhir
  `);
  return Number(row.nomor_terakhir);
}

export const pad = (n, width = 4) => String(n).padStart(width, '0');
