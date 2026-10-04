-- Jalankan di SQL Editor sebagai admin yang memiliki CREATEROLE dan hak
-- mengelola database db13052556d1ee44f1. Ganti TIGA password di bawah.
-- Script khusus setup pertama; berhenti bila role/schema sudah ada.
-- Semua perubahan dalam transaksi: jika gagal, jalankan ROLLBACK;
-- Jangan membagikan salinan script yang sudah diisi password.

BEGIN;

DO $setup$
DECLARE
  migrator_password text := 'GANTI_PASSWORD_MIGRATOR_MINIMAL_32_KARAKTER';
  app_password text := 'GANTI_PASSWORD_APP_MINIMAL_32_KARAKTER';
  report_password text := 'GANTI_PASSWORD_REPORT_MINIMAL_32_KARAKTER';
BEGIN
  IF current_database() <> 'db13052556d1ee44f1' THEN
    RAISE EXCEPTION 'Database salah: %, harus db13052556d1ee44f1', current_database();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = current_user AND (rolsuper OR rolcreaterole)
  ) THEN
    RAISE EXCEPTION 'Role % tidak punya CREATEROLE. Jalankan sebagai admin Sumobase.', current_user;
  END IF;
  IF length(migrator_password) < 32 OR length(app_password) < 32 OR length(report_password) < 32
    OR migrator_password LIKE 'GANTI_%' OR app_password LIKE 'GANTI_%' OR report_password LIKE 'GANTI_%'
    OR migrator_password = app_password OR migrator_password = report_password OR app_password = report_password THEN
    RAISE EXCEPTION 'Isi tiga password berbeda, masing-masing minimal 32 karakter.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('si_migrator', 'si_app', 'si_report'))
    OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'finance') THEN
    RAISE EXCEPTION 'Role SI atau schema finance sudah ada. Periksa setup sebelumnya; jangan ditimpa.';
  END IF;
  EXECUTE format('CREATE ROLE si_migrator LOGIN PASSWORD %L NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2', migrator_password);
  EXECUTE format('CREATE ROLE si_app LOGIN PASSWORD %L NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10', app_password);
  EXECUTE format('CREATE ROLE si_report LOGIN PASSWORD %L NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5', report_password);
  -- Admin setup perlu SET ROLE/mengelola objek milik migrator.
  EXECUTE format('GRANT si_migrator TO %I', current_user);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO si_migrator, si_app, si_report', current_database());
  -- Diperlukan drizzle-kit untuk CREATE SCHEMA IF NOT EXISTS finance.
  EXECUTE format('GRANT CREATE ON DATABASE %I TO si_migrator', current_database());
END
$setup$;

CREATE SCHEMA finance AUTHORIZATION si_migrator;
REVOKE ALL ON SCHEMA finance FROM PUBLIC;
GRANT USAGE ON SCHEMA finance TO si_app, si_report;

REVOKE ALL ON SCHEMA public FROM si_migrator, si_app, si_report;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM si_migrator, si_app, si_report;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM si_migrator, si_app, si_report;

ALTER DEFAULT PRIVILEGES FOR ROLE si_migrator IN SCHEMA finance
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO si_app;
ALTER DEFAULT PRIVILEGES FOR ROLE si_migrator IN SCHEMA finance
  GRANT USAGE, SELECT ON SEQUENCES TO si_app;
ALTER DEFAULT PRIVILEGES FOR ROLE si_migrator IN SCHEMA finance
  GRANT SELECT ON TABLES TO si_report;
-- PostgreSQL memberi EXECUTE fungsi ke PUBLIC secara global secara default.
ALTER DEFAULT PRIVILEGES FOR ROLE si_migrator
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

ALTER ROLE si_migrator SET search_path = finance;
ALTER ROLE si_migrator SET lock_timeout = '3s';
ALTER ROLE si_migrator SET statement_timeout = '60s';
ALTER ROLE si_app SET search_path = finance;
ALTER ROLE si_app SET statement_timeout = '15s';
ALTER ROLE si_app SET lock_timeout = '2s';
ALTER ROLE si_app SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE si_report SET search_path = finance;
ALTER ROLE si_report SET statement_timeout = '120s';
ALTER ROLE si_report SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE si_report SET default_transaction_read_only = on;

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname IN ('si_app', 'si_report') AND (
      r.rolsuper OR has_schema_privilege(r.rolname, 'public', 'CREATE')
      OR EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm') AND (
          has_table_privilege(r.rolname, c.oid, 'SELECT')
          OR has_table_privilege(r.rolname, c.oid, 'INSERT')
          OR has_table_privilege(r.rolname, c.oid, 'UPDATE')
          OR has_table_privilege(r.rolname, c.oid, 'DELETE')
          OR has_table_privilege(r.rolname, c.oid, 'TRUNCATE')
        )
      )
    )
  ) THEN
    RAISE EXCEPTION 'Isolasi gagal: periksa grant dari PUBLIC. Tidak ada grant global yang diubah oleh script ini.';
  END IF;
  IF NOT has_database_privilege('si_migrator', current_database(), 'CREATE') THEN
    RAISE EXCEPTION 'Admin harus memberikan CREATE pada database kepada si_migrator.';
  END IF;
END
$verify$;

COMMIT;

-- Hasil yang diharapkan: tiga role; superuser=false, create_role=false,
-- create_public=false; usage_finance=true.
SELECT rolname, rolsuper AS superuser, rolcreaterole AS create_role,
       has_schema_privilege(rolname, 'public', 'CREATE') AS create_public,
       has_schema_privilege(rolname, 'finance', 'USAGE') AS usage_finance
FROM pg_roles
WHERE rolname IN ('si_migrator', 'si_app', 'si_report')
ORDER BY rolname;

-- Setelah berhasil: isi .env.production dengan koneksi sesuai role:
-- DATABASE_URL            -> si_app, transaction pooler
-- REPORT_DATABASE_URL     -> si_report, transaction pooler
-- SESSION_DATABASE_URL    -> si_app, session pooler atau direct
-- SI_MIGRATOR_DATABASE_URL -> si_migrator, direct
-- Pastikan Sumobase mendukung login role tambahan lewat pooler. Jika tidak,
-- gunakan koneksi direct untuk role baru; jangan menebak format username pooler.
-- Password dalam URL harus di-URL-encode jika mengandung karakter khusus.
-- Tabel aplikasi dibuat melalui migrasi proyek setelah koneksi diverifikasi.
