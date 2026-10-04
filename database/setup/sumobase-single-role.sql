-- Alternatif satu akun, disetujui pemilik deployment pada 4 Oktober 2026.
-- Khusus database SI ini; runtime/migrasi/laporan memakai akun yang sama.
-- Pemilik tetap dapat memberikan kembali haknya dan mengubah struktur finance.
-- Bukan pengganti pembatasan tiga role. Tidak mematikan dbGuard.
-- Aman diulang. Jika gagal dalam SQL Editor, jalankan ROLLBACK terpisah.
BEGIN;
SET LOCAL lock_timeout = '3s';

DO $check$
BEGIN
  IF current_database() <> 'db13052556d1ee44f1'
     OR current_user <> 'uei7R4gAeINbTJZed' THEN
    RAISE EXCEPTION 'Database/akun tidak sesuai deployment SI yang disetujui';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  ) THEN
    RAISE EXCEPTION 'Schema public berisi objek data; periksa sebelum mengubah izin';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_namespace WHERE nspname = 'finance'
    AND pg_get_userbyid(nspowner) <> current_user
  ) THEN
    RAISE EXCEPTION 'Schema finance dimiliki akun lain';
  END IF;
END
$check$;

CREATE SCHEMA IF NOT EXISTS finance AUTHORIZATION CURRENT_USER;
REVOKE ALL ON SCHEMA finance FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM CURRENT_USER;

DO $verify$
BEGIN
  IF has_schema_privilege('public', 'CREATE') THEN
    RAISE EXCEPTION 'CREATE public masih aktif melalui grant lain';
  END IF;
END
$verify$;
COMMIT;

-- Pemulihan izin sebelum setup: GRANT CREATE ON SCHEMA public TO CURRENT_USER;
-- Hentikan API sebelum pemulihan. Jangan DROP schema/data untuk rollback.
