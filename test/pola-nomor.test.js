import { describe, expect, it } from 'vitest';
import { normalisasiPolaNomor, isiPolaNomor } from '../src/shared/utils/polaNomor.js';

describe('normalisasiPolaNomor', () => {
  it.each([
    ['{PT}/{TAHUN}/{TIPE}/{NO}', '{PT}/{TAHUN}/{TIPE}/{NO}'],
    ['TST/2026/KPR/01', 'TST/{TAHUN}/KPR/{NO}'],
    ['TST/{2026}/KPR/{NO}', 'TST/{TAHUN}/KPR/{NO}'],
    ['PRSM-{01}', 'PRSM-{NO}'],
    ['01/SPPR/2026', '{NO}/SPPR/{TAHUN}'],
    ['SPPR/KPR', 'SPPR/KPR/{NO}'],
    ['007', '{NO}'],
    ['', '{NO}'],
  ])('%s -> %s', (input, expected) => {
    expect(normalisasiPolaNomor(input)).toBe(expected);
  });

  it('tahun di luar segmen sendiri tidak dianggap tahun', () => {
    expect(normalisasiPolaNomor('A2026/5')).toBe('A2026/{NO}');
  });
});

describe('isiPolaNomor', () => {
  it('mengisi semua token', () => {
    const pt = { namaPt: 'PT Pesona Raya Sejahtera Mandiri', singkatan: null };
    expect(isiPolaNomor('{PT}/{TAHUN}/{BULAN}/{TIPE}/{NO}', { pt, tipe: 'in_house', tanggal: '2026-11-16', nomor: 7 }))
      .toBe('PRSM/2026/11/IN_HOUSE/0007');
  });

  it('mengisi bulan romawi tanpa bentrok dengan {BULAN}', () => {
    expect(isiPolaNomor('{NO}/{BULAN_ROMAWI}/{BULAN}', { pt: { singkatan: 'X' }, tipe: 'kpr', tanggal: '2026-04-01', nomor: 1 }))
      .toBe('0001/IV/04');
  });
});
