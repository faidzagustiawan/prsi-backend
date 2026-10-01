-- =============================================================================
-- PodorukunSI - 001: Role & schema isolation
-- Dijalankan SEKALI oleh owner database (neondb_owner) via psql:
--   psql "$OWNER_DATABASE_URL" \
--     -v si_migrator_password='...' -v si_app_password='...' -v si_report_password='...' \
--     -f 001_roles_and_schema.sql
-- Script ini TIDAK mengubah tabel, data, grant, atau role milik Track.
-- =============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Role
--    si_migrator : pemilik schema finance, hanya untuk migrasi (tidak dipakai app)
--    si_app      : runtime backend SI, tidak punya akses ke schema public
--    si_report   : query laporan di read replica, read-only
-- -----------------------------------------------------------------------------
CREATE ROLE si_migrator LOGIN PASSWORD :'si_migrator_password' NOINHERIT CONNECTION LIMIT 2;
CREATE ROLE si_app      LOGIN PASSWORD :'si_app_password'      NOINHERIT CONNECTION LIMIT 10;
CREATE ROLE si_report   LOGIN PASSWORD :'si_report_password'   NOINHERIT CONNECTION LIMIT 5;

-- Timeout supaya SI tidak pernah memegang lock lama di tabel Track
-- (lock ACCESS SHARE yang lama bisa membuat ALTER TABLE Track mengantre
-- dan seluruh query Track ikut tertahan di belakangnya).
ALTER ROLE si_migrator SET lock_timeout = '3s';
ALTER ROLE si_migrator SET statement_timeout = '60s';

ALTER ROLE si_app SET statement_timeout = '15s';
ALTER ROLE si_app SET lock_timeout = '2s';
ALTER ROLE si_app SET idle_in_transaction_session_timeout = '10s';

ALTER ROLE si_report SET statement_timeout = '120s';
ALTER ROLE si_report SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE si_report SET default_transaction_read_only = on;

-- -----------------------------------------------------------------------------
-- 2. Tutup schema public untuk semua role SI
--    (tidak mengubah grant PUBLIC/Track; hanya memastikan role SI tidak punya apa-apa)
-- -----------------------------------------------------------------------------
REVOKE ALL ON SCHEMA public FROM si_migrator, si_app, si_report;
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM si_migrator, si_app, si_report;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM si_migrator, si_app, si_report;

-- si_migrator butuh USAGE untuk me-resolve nama tabel Track di fungsi kontrak.
-- USAGE tidak memberi hak CREATE; hak SELECT diberikan per kolom di 002.
GRANT USAGE ON SCHEMA public TO si_migrator;

-- -----------------------------------------------------------------------------
-- 3. Schema finance
-- -----------------------------------------------------------------------------
CREATE SCHEMA finance AUTHORIZATION si_migrator;

-- drizzle-kit migrate selalu menjalankan CREATE SCHEMA IF NOT EXISTS untuk
-- schema tabel riwayat migrasinya, dan Postgres memeriksa hak CREATE database
-- sebelum mengecek keberadaan schema. Hak ini hanya memungkinkan membuat schema
-- baru (tidak menyentuh public); check-migrations.js menolak schema selain finance.
SELECT format('GRANT CREATE ON DATABASE %I TO si_migrator', current_database()) \gexec

GRANT USAGE ON SCHEMA finance TO si_app, si_report;

-- Objek baru yang dibuat si_migrator otomatis bisa dipakai app/report
ALTER DEFAULT PRIVILEGES FOR ROLE si_migrator IN SCHEMA finance
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO si_app;
ALTER DEFAULT PRIVILEGES FOR ROLE si_migrator IN SCHEMA finance
  GRANT USAGE, SELECT ON SEQUENCES TO si_app;
ALTER DEFAULT PRIVILEGES FOR ROLE si_migrator IN SCHEMA finance
  GRANT SELECT ON TABLES TO si_report;

-- Fungsi tidak otomatis executable oleh siapa pun; grant eksplisit di 002
ALTER DEFAULT PRIVILEGES FOR ROLE si_migrator IN SCHEMA finance
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- search_path role SI hanya finance, supaya query tanpa prefix tidak pernah
-- jatuh ke tabel public
ALTER ROLE si_migrator SET search_path = finance;
ALTER ROLE si_app      SET search_path = finance;
ALTER ROLE si_report   SET search_path = finance;

COMMIT;
