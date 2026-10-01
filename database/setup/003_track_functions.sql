-- =============================================================================
-- PodorukunSI - 003: Fungsi kontrak baca data Track
-- Dijalankan sebagai si_migrator (pemilik schema finance):
--   psql "$SI_MIGRATOR_DATABASE_URL" -f 003_track_functions.sql
-- Membutuhkan grant kolom dari 002. Lihat header 002 untuk prinsip desain.
-- =============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- -----------------------------------------------------------------------------
-- Fungsi kontrak (dibuat & dimiliki si_migrator)
-- -----------------------------------------------------------------------------
CREATE FUNCTION finance.track_companies()
RETURNS TABLE (id uuid, nama_pt text, kode_pt text, alamat text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT c.id, c.nama_pt::text, c.kode_pt::text, c.alamat::text
  FROM public.companies c;
END;
$$;

-- Hierarki unit lengkap per perusahaan
CREATE FUNCTION finance.track_units(p_company_id uuid)
RETURNS TABLE (
  unit_id uuid, nomor_unit text, tipe_rumah text,
  luas_tanah numeric, luas_bangunan numeric, status_pembangunan text,
  cluster_id uuid, nama_cluster text,
  project_id uuid, nama_proyek text, company_id uuid
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT u.id, u.nomor_unit::text, u.tipe_rumah::text,
         u.luas_tanah::numeric, u.luas_bangunan::numeric, u.status_pembangunan::text,
         cl.id, cl.nama_cluster::text,
         p.id, p.nama_proyek::text, p.company_id
  FROM public.units u
  JOIN public.clusters cl ON cl.id = u.cluster_id
  JOIN public.projects p  ON p.id = cl.project_id
  WHERE p.company_id = p_company_id;
END;
$$;

-- Penjualan unit (dasar piutang konsumen)
CREATE FUNCTION finance.track_assignments(p_company_id uuid)
RETURNS TABLE (
  assignment_id uuid, unit_id uuid, project_id uuid,
  customer_id uuid, customer_nama text, customer_email text, customer_telepon text,
  tanggal_pembelian date, status_kepemilikan text, tipe_pembayaran text,
  harga_total numeric, dp numeric, total_dibayar numeric,
  jatuh_tempo_kpr date, tenor_bulan integer, keterangan_kpr text,
  updated_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT a.id, a.unit_id, p.id,
         usr.id, usr.nama::text, usr.email::text, usr.nomor_telepon::text,
         a.tanggal_pembelian::date, a.status_kepemilikan::text, a.tipe_pembayaran::text,
         a.harga_total::numeric, a.dp::numeric, a.total_dibayar::numeric,
         a.jatuh_tempo_kpr::date, a.tenor_bulan::integer, a.keterangan_kpr::text,
         a.updated_at::timestamptz
  FROM public.property_assignments a
  JOIN public.units u     ON u.id = a.unit_id
  JOIN public.clusters cl ON cl.id = u.cluster_id
  JOIN public.projects p  ON p.id = cl.project_id
  JOIN public.users usr   ON usr.id = a.user_id
  WHERE p.company_id = p_company_id;
END;
$$;

-- Pembayaran konsumen untuk dijurnal SI. Dibaca bertahap (polling) berdasarkan
-- created_at, tanpa trigger di tabel Track.
CREATE FUNCTION finance.track_payments_since(p_company_id uuid, p_since timestamptz, p_limit integer DEFAULT 500)
RETURNS TABLE (
  payment_id uuid, assignment_id uuid, jumlah_bayar numeric, tanggal_bayar date,
  catatan text, bukti_pembayaran text, created_by uuid, created_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT ph.id, ph.assignment_id, ph.jumlah_bayar::numeric, ph.tanggal_bayar::date,
         ph.catatan::text, ph.bukti_pembayaran::text, ph.created_by, ph.created_at::timestamptz
  FROM public.payment_history ph
  JOIN public.property_assignments a ON a.id = ph.assignment_id
  JOIN public.units u     ON u.id = a.unit_id
  JOIN public.clusters cl ON cl.id = u.cluster_id
  JOIN public.projects p  ON p.id = cl.project_id
  WHERE p.company_id = p_company_id
    AND ph.created_at > p_since
  ORDER BY ph.created_at, ph.id
  LIMIT LEAST(GREATEST(p_limit, 1), 1000);
END;
$$;

REVOKE ALL ON FUNCTION finance.track_companies() FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.track_units(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.track_assignments(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION finance.track_payments_since(uuid, timestamptz, integer) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION finance.track_companies() TO si_app, si_report;
GRANT EXECUTE ON FUNCTION finance.track_units(uuid) TO si_app, si_report;
GRANT EXECUTE ON FUNCTION finance.track_assignments(uuid) TO si_app, si_report;
GRANT EXECUTE ON FUNCTION finance.track_payments_since(uuid, timestamptz, integer) TO si_app, si_report;

COMMIT;
