-- =============================================================================
-- PodorukunSI - 002: Whitelist kolom Track (read-only)
-- Dijalankan oleh owner database (neondb_owner):
--   psql "$OWNER_DATABASE_URL" -f 002_track_read_contract.sql
-- Fungsi kontrak dibuat di 003 (dijalankan sebagai si_migrator).
--
-- Prinsip:
-- * si_migrator hanya dapat SELECT per KOLOM yang diperlukan (whitelist).
--   Kolom sensitif (password_hash, apple_refresh_token, dll) tidak pernah di-grant.
-- * Akses data Track hanya lewat fungsi finance.track_* (SECURITY DEFINER, plpgsql).
--   plpgsql TIDAK membuat dependency ke kolom Track, jadi migrasi Track
--   (drop/rename/ubah tipe kolom) tidak akan pernah terblokir oleh SI.
--   Kalau Track berubah, yang gagal adalah fungsi SI (terdeteksi oleh contract test SI),
--   bukan deploy Track.
-- * Enum Track di-cast ke text supaya SI tidak bergantung pada tipe enum Track.
-- * Tidak ada view, trigger, atau foreign key ke tabel public.
--
-- Kolom di bawah disesuaikan dengan dump Neon 2026-07-18. Cek ulang ke DB live
-- sebelum dijalankan (GRANT ke kolom yang tidak ada akan error dan seluruh script rollback).
-- =============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Whitelist kolom Track (column-level SELECT)
-- -----------------------------------------------------------------------------
GRANT SELECT (id, nama_pt, kode_pt, alamat)
  ON public.companies TO si_migrator;

GRANT SELECT (id, company_id, nama_proyek, lokasi, status)
  ON public.projects TO si_migrator;

GRANT SELECT (id, project_id, nama_cluster)
  ON public.clusters TO si_migrator;

GRANT SELECT (id, cluster_id, nomor_unit, tipe_rumah, luas_tanah, luas_bangunan, status_pembangunan)
  ON public.units TO si_migrator;

-- Data konsumen minimum untuk piutang. TIDAK termasuk password_hash, apple_refresh_token.
GRANT SELECT (id, company_id, nama, email, nomor_telepon)
  ON public.users TO si_migrator;

GRANT SELECT (id, user_id, unit_id, tanggal_pembelian, status_kepemilikan, tipe_pembayaran,
              harga_total, dp, total_dibayar, jatuh_tempo_kpr, tenor_bulan, keterangan_kpr,
              created_at, updated_at)
  ON public.property_assignments TO si_migrator;

GRANT SELECT (id, assignment_id, jumlah_bayar, tanggal_bayar, catatan, bukti_pembayaran,
              created_by, created_at)
  ON public.payment_history TO si_migrator;

COMMIT;
