// src/modules/hutang/hutang.helpers.js
// Pencarian dan validasi bersama untuk modul hutang, pinjaman, dan kontrak.
import { and, asc, eq, sql } from 'drizzle-orm';
import { akun, kodePembantu } from '../../shared/schemas/akuntansi.schema.js';
import { trkProjects, trkUnits } from '../../shared/schemas/track.schema.js';
import { AppError } from '../../shared/utils/AppError.js';
import { generateKode } from '../kode-pembantu/kode-pembantu.routes.js';

const leaf = sql`NOT EXISTS (SELECT 1 FROM finance.akun c WHERE c.induk_id = ${akun.id})`;

/**
 * Akun default untuk kategori hutang/piutang: akun detail aktif dengan
 * kategori_hutang_piutang tersebut, kode terkecil. `sisi` = 'hutang' (akun
 * kategori hutang) atau 'aktiva' (piutang, mis. piutang antar proyek).
 */
export async function akunUntukKategori(tx, kategoriHp, sisi = 'hutang') {
  const [row] = await tx.select().from(akun)
    .where(and(eq(akun.kategoriHutangPiutang, kategoriHp), eq(akun.kategori, sisi), eq(akun.aktif, true), leaf))
    .orderBy(asc(akun.kode)).limit(1);
  if (!row) {
    const jenis = sisi === 'hutang' ? 'hutang' : 'piutang';
    throw new AppError(`Belum ada akun ${jenis} untuk kategori ${kategoriHp}. Tandai akunnya di COA (kategori hutang/piutang).`, 422);
  }
  return row;
}

export async function findAkunAktif(tx, id, label = 'Akun') {
  const [row] = await tx.select().from(akun).where(eq(akun.id, id)).limit(1);
  if (!row || !row.aktif) throw new AppError(`${label} tidak ditemukan atau nonaktif.`, 422);
  return row;
}

export async function assertKasBank(tx, id) {
  const row = await findAkunAktif(tx, id, 'Akun kas/bank');
  if (!row.isKasBank) throw new AppError(`Akun ${row.kode} bukan akun kas/bank.`, 422);
  return row;
}

export async function findProyekAktif(tx, id) {
  const [row] = await tx.select().from(trkProjects).where(and(eq(trkProjects.id, id), eq(trkProjects.isDeleted, false))).limit(1);
  if (!row) throw new AppError('Proyek tidak ditemukan.', 404);
  return row;
}

export async function findUnitDiProyek(tx, unitId, proyekId) {
  const [row] = await tx.select().from(trkUnits).where(and(eq(trkUnits.id, unitId), eq(trkUnits.isDeleted, false))).limit(1);
  if (!row) throw new AppError('Kavling tidak ditemukan.', 404);
  if (row.projectId !== proyekId) throw new AppError('Kavling tidak berada di proyek tersebut.', 422);
  return row;
}

export async function findKodePembantu(tx, id, kategori) {
  const [row] = await tx.select().from(kodePembantu).where(eq(kodePembantu.id, id)).limit(1);
  if (!row || !row.aktif) throw new AppError('Kode pembantu tidak ditemukan atau nonaktif.', 422);
  if (kategori && row.kategori !== kategori) throw new AppError(`Kode pembantu ${row.nama} bukan kategori ${kategori}.`, 422);
  return row;
}

/** Pakai kode pembantu yang dipilih, atau buat baru dari nama (FE: "pihak baru"). */
export async function resolveKodePembantu(tx, { id, namaBaru, kategori, proyekId, proyekLawanId = null }) {
  if (id) return findKodePembantu(tx, id, kategori);
  if (!namaBaru) throw new AppError('Pilih pihak, atau tulis nama pihak baru.', 422);
  const [created] = await tx.insert(kodePembantu).values({
    kode: await generateKode(tx, kategori), nama: namaBaru.trim(), kategori, proyekId, proyekLawanId,
  }).returning();
  return created;
}

/** Kode pembantu antar proyek di `proyekId` yang mewakili `proyekLawanId`; dibuat bila belum ada. */
export async function kodePembantuAntarProyek(tx, proyekId, proyekLawanId) {
  const [found] = await tx.select().from(kodePembantu)
    .where(and(eq(kodePembantu.kategori, 'antar_proyek'), eq(kodePembantu.proyekId, proyekId), eq(kodePembantu.proyekLawanId, proyekLawanId)))
    .limit(1);
  if (found) return found;
  const lawan = await findProyekAktif(tx, proyekLawanId);
  return resolveKodePembantu(tx, { namaBaru: lawan.nama, kategori: 'antar_proyek', proyekId, proyekLawanId });
}

/** Info jurnal ringkas untuk DTO dokumen modul. */
export const jurnalInfo = (map, jurnalId) => {
  const j = jurnalId ? map.get(jurnalId) : null;
  return j
    ? { jurnalId: j.id, nomorJurnal: j.nomorJurnal, jurnalStatus: j.status, butuhLampiran: j.status === 'draft' && j.jumlahLampiran === 0 }
    : { jurnalId: null, nomorJurnal: null, jurnalStatus: null, butuhLampiran: false };
};
