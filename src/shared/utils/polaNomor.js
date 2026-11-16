// src/shared/utils/polaNomor.js
//
// Pola nomor dokumen memakai token {PT} {TAHUN} {BULAN} {BULAN_ROMAWI} {TIPE} {NO}.
// Pengguna boleh mengetik contoh nomor (mis. "TST/2026/KPR/01"); pola itu
// dinormalisasi di sini supaya semua klien melihat pola yang sama.
import { pad } from './penomoran.js';
import { TIPE_TRANSAKSI_LABEL } from '../constants.js';

export const POLA_NOMOR_DEFAULT = '{PT}/{TAHUN}/{TIPE}/{NO}';

const SEP = /([/\-_.])/;
const TAHUN = /^20\d{2}$/;
const ROMAWI = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

/**
 * Ubah input pengguna menjadi pola bertoken.
 * - {2026} atau 2026 (tahun 20xx sebagai satu segmen) menjadi {TAHUN}
 * - {01} atau angka terakhir yang bukan tahun menjadi {NO}
 * - tanpa angka urut sama sekali: "/{NO}" ditambahkan di akhir
 */
export function normalisasiPolaNomor(input) {
  let pola = String(input ?? '').trim();
  if (!pola) return '{NO}';
  pola = pola.replace(/\{20\d{2}\}/g, '{TAHUN}');
  if (!pola.includes('{NO}')) pola = pola.replace(/\{\d+\}/, '{NO}');

  const parts = pola.split(SEP);
  if (!pola.includes('{TAHUN}')) {
    const i = parts.findIndex((p) => TAHUN.test(p));
    if (i >= 0) parts[i] = '{TAHUN}';
  }
  if (!parts.includes('{NO}') && !pola.includes('{NO}')) {
    let i = parts.length - 1;
    while (i >= 0 && !/^\d+$/.test(parts[i])) i -= 1;
    if (i >= 0) parts[i] = '{NO}';
    else parts.push('/', '{NO}');
  }
  return parts.join('');
}

/** Isi token pola; dipakai penomoran dokumen dan contoh nomor di template. */
export function isiPolaNomor(pola, { pt, tipe, tanggal, nomor }) {
  const [tahun, bulan] = tanggal.split('-');
  const singkatan = pt?.singkatan
    || String(pt?.namaPt ?? '').split(/\s+/).filter((w) => w && w !== 'PT').map((w) => w[0]).join('').toUpperCase().slice(0, 4);
  return pola.replace('{PT}', singkatan).replace('{TAHUN}', tahun)
    .replace('{BULAN_ROMAWI}', ROMAWI[Number(bulan) - 1]).replace('{BULAN}', bulan)
    .replace('{TIPE}', TIPE_TRANSAKSI_LABEL[tipe].toUpperCase().replace(' ', '_')).replace('{NO}', pad(nomor));
}
