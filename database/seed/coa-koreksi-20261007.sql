-- Koreksi COA yang sudah di-seed di produksi 7 Oktober 2026. Jalankan SETELAH
-- migrasi 0006 dan 0007 (kategori_hutang_piutang + akun.kategori_hp_id).
--
--   1. KAS 11100 -> 111000 (ditolak bila akun sudah dipakai jurnal/saldo awal).
--   2. 523100 Pendapatan Lain-lain pindah induk ke 400000 Pendapatan.
--   3. 113530 Piutang Penjualan diberi kategori pembeli (Penjualan).
--
-- Idempoten: langkah yang sudah diterapkan dilewati. Setiap perubahan dicatat
-- di audit_logs per field, sama seperti perubahan lewat API.
BEGIN;

DO $$
DECLARE
	kas_id uuid;
	pendapatan_id uuid;
	target_id uuid;
	induk_lama text;
	kategori_id uuid;
	kategori_nama text;
	kategori_lama text;
BEGIN
	-- 1. Kode KAS
	SELECT id INTO kas_id FROM finance.akun WHERE kode = '11100';
	IF kas_id IS NOT NULL THEN
		IF EXISTS (SELECT 1 FROM finance.akun WHERE kode = '111000') THEN
			RAISE EXCEPTION 'Kode 111000 sudah dipakai akun lain';
		END IF;
		IF EXISTS (SELECT 1 FROM finance.jurnal_detail WHERE akun_id = kas_id)
			OR EXISTS (SELECT 1 FROM finance.saldo_awal WHERE akun_id = kas_id) THEN
			RAISE EXCEPTION 'Akun 11100 sudah dipakai jurnal atau saldo awal; kode tidak bisa diubah';
		END IF;
		UPDATE finance.akun SET kode = '111000', updated_at = now() WHERE id = kas_id;
		INSERT INTO finance.audit_logs (action, entity, entity_id, field, nilai_lama, nilai_baru, summary)
		VALUES ('update', 'akun', kas_id::text, 'Kode akun', '11100', '111000', 'Koreksi COA 07/10/2026');
	END IF;

	-- 2. Induk 523100
	SELECT id INTO pendapatan_id FROM finance.akun WHERE kode = '400000';
	SELECT a.id, p.kode || ' ' || p.nama INTO target_id, induk_lama
	FROM finance.akun a LEFT JOIN finance.akun p ON p.id = a.induk_id WHERE a.kode = '523100';
	IF pendapatan_id IS NULL OR target_id IS NULL THEN
		RAISE EXCEPTION 'Akun 400000 atau 523100 tidak ditemukan';
	END IF;
	IF induk_lama IS DISTINCT FROM (SELECT kode || ' ' || nama FROM finance.akun WHERE id = pendapatan_id) THEN
		UPDATE finance.akun SET induk_id = pendapatan_id, updated_at = now() WHERE id = target_id;
		INSERT INTO finance.audit_logs (action, entity, entity_id, field, nilai_lama, nilai_baru, summary)
		SELECT 'update', 'akun', target_id::text, 'Akun induk', coalesce(induk_lama, '-'), kode || ' ' || nama, 'Koreksi COA 07/10/2026'
		FROM finance.akun WHERE id = pendapatan_id;
	END IF;

	-- 3. Kategori 113530
	SELECT id, nama INTO kategori_id, kategori_nama FROM finance.kategori_hutang_piutang WHERE kode = 'pembeli';
	SELECT a.id, k.nama INTO target_id, kategori_lama
	FROM finance.akun a LEFT JOIN finance.kategori_hutang_piutang k ON k.id = a.kategori_hp_id WHERE a.kode = '113530';
	IF kategori_id IS NULL OR target_id IS NULL THEN
		RAISE EXCEPTION 'Kategori pembeli atau akun 113530 tidak ditemukan (migrasi 0006 sudah dijalankan?)';
	END IF;
	IF kategori_lama IS DISTINCT FROM kategori_nama THEN
		UPDATE finance.akun SET kategori_hp_id = kategori_id, updated_at = now() WHERE id = target_id;
		INSERT INTO finance.audit_logs (action, entity, entity_id, field, nilai_lama, nilai_baru, summary)
		VALUES ('update', 'akun', target_id::text, 'Kategori hutang/piutang', coalesce(kategori_lama, '-'), kategori_nama, 'Koreksi COA 07/10/2026');
	END IF;
END $$;

SELECT a.kode, a.nama, p.kode AS induk, k.kode AS kategori_hp
FROM finance.akun a
LEFT JOIN finance.akun p ON p.id = a.induk_id
LEFT JOIN finance.kategori_hutang_piutang k ON k.id = a.kategori_hp_id
WHERE a.kode IN ('111000', '111100', '113530', '523100')
ORDER BY a.kode;
COMMIT;
