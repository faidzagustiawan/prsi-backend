import { describe, it, expect, vi } from 'vitest';

// sniffMime tidak menyentuh database; modul database cukup dipalsukan supaya
// test tidak butuh koneksi.
vi.mock('../src/config/database.js', () => ({ db: {}, reportDb: {} }));
vi.mock('../src/config/env.js', () => ({ env: { uploadDir: '/tmp' } }));

const { sniffMime } = await import('../src/modules/lampiran/lampiran.service.js');

describe('sniffMime', () => {
  it('mengenali PDF, JPEG, PNG, WEBP dari isi berkas', () => {
    expect(sniffMime(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffMime(Buffer.from('RIFF\0\0\0\0WEBP'))).toBe('image/webp');
  });

  it('menolak berkas lain walaupun namanya .pdf', () => {
    expect(sniffMime(Buffer.from('MZ\x90\0'))).toBeNull();
    expect(sniffMime(Buffer.from('<html>'))).toBeNull();
    expect(sniffMime(Buffer.alloc(0))).toBeNull();
  });
});
