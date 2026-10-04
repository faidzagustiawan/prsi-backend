import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/config/database.js', () => ({ db: {}, reportDb: {} }));

const { hitungJadwal } = await import('../src/modules/penjualan/penjualan.helpers.js');
const { statusPeriode } = await import('../src/modules/penjualan/piutang.service.js');

describe('hitungJadwal', () => {
  it('tanggal acuan 31 jatuh ke akhir bulan yang lebih pendek', () => {
    const baris = hitungJadwal({ tanggalAcuan: 31, nominalPerBulan: 10, tanggalMulai: '2026-01-01', jatuhTempoTerakhir: '2026-04-30' });
    expect(baris.map((b) => b.tanggal)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('melewati bulan pertama bila tanggal acuan sebelum tanggal mulai', () => {
    const baris = hitungJadwal({ tanggalAcuan: 5, nominalPerBulan: 10, tanggalMulai: '2026-01-10', jatuhTempoTerakhir: '2026-03-31' });
    expect(baris.map((b) => b.tanggal)).toEqual(['2026-02-05', '2026-03-05']);
    expect(baris.map((b) => b.keterangan)).toEqual(['DP 1', 'DP 2']);
  });

  it('melintasi tahun dan tahun kabisat', () => {
    const baris = hitungJadwal({ tanggalAcuan: 29, nominalPerBulan: 10, tanggalMulai: '2027-12-01', jatuhTempoTerakhir: '2028-02-29' });
    expect(baris.map((b) => b.tanggal)).toEqual(['2027-12-29', '2028-01-29', '2028-02-29']);
  });
});

describe('statusPeriode (sama dengan computeStatus FE)', () => {
  const row = (o) => ({ tanggalJatuhTempo: '2026-05-15', tagihan: 100, dibayar: 0, tanggalBayar: null, ...o });
  it.each([
    [row({ dibayar: 100, tanggalBayar: '2026-05-15' }), '2026-06-01', 'lunas'],
    [row({ dibayar: 100, tanggalBayar: '2026-05-10' }), '2026-06-01', 'bayar_awal'],
    [row({ dibayar: 100, tanggalBayar: '2026-05-20' }), '2026-06-01', 'terlambat'],
    [row({ dibayar: 100, tanggalBayar: '2026-05-01' }), '2026-05-02', 'dibayar_dimuka'],
    [row({ dibayar: 40, tanggalBayar: '2026-05-10' }), '2026-06-01', 'sebagian'],
    [row(), '2026-06-01', 'belum_bayar'],
    [row(), '2026-05-01', 'belum_jatuh_tempo'],
  ])('%#', (r, hariIni, expected) => {
    expect(statusPeriode(r, hariIni)).toBe(expected);
  });
});
