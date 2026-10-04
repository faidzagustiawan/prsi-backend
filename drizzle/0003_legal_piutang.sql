CREATE TABLE "finance"."akun_sistem" (
	"kunci" varchar(40) PRIMARY KEY NOT NULL,
	"akun_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."alokasi_pembayaran" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"penjualan_id" uuid NOT NULL,
	"jadwal_id" uuid,
	"nominal" numeric(18, 2) NOT NULL,
	"manual" boolean DEFAULT false NOT NULL,
	"diubah_oleh" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."dokumen" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"no_dokumen" varchar(60) NOT NULL,
	"pt_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"assignment_id" uuid,
	"template_id" uuid,
	"tipe_transaksi" varchar(10) NOT NULL,
	"tanggal" date NOT NULL,
	"status" varchar(20) DEFAULT 'draft' NOT NULL,
	"induk_id" uuid,
	"data" jsonb NOT NULL,
	"jadwal" jsonb,
	"difinalkan_oleh" uuid,
	"difinalkan_pada" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dokumen_no_dokumen_unique" UNIQUE("no_dokumen")
);
--> statement-breakpoint
CREATE TABLE "finance"."dokumen_pasal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dokumen_id" uuid NOT NULL,
	"pustaka_id" uuid,
	"urutan" smallint NOT NULL,
	"judul" varchar(150) NOT NULL,
	"teks" text NOT NULL,
	"nilai_field" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."jadwal_angsuran" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"penjualan_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"dokumen_id" uuid NOT NULL,
	"no_urut" smallint NOT NULL,
	"tanggal" date NOT NULL,
	"jumlah" numeric(18, 2) NOT NULL,
	"keterangan" varchar(100),
	"aktif" boolean DEFAULT true NOT NULL,
	"track_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jadwal_angsuran_track_id_unique" UNIQUE("track_id")
);
--> statement-breakpoint
CREATE TABLE "finance"."outbox_track" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jenis" varchar(30) NOT NULL,
	"ref_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(10) DEFAULT 'tertunda' NOT NULL,
	"percobaan" integer DEFAULT 0 NOT NULL,
	"galat_terakhir" text,
	"dikirim_pada" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."pasal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"judul" varchar(150) NOT NULL,
	"isi" text NOT NULL,
	"berlaku_untuk" varchar(20) DEFAULT 'semua' NOT NULL,
	"pt_id" uuid,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"aktif" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."penjualan_keuangan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"dokumen_id" uuid,
	"nilai_sppr" numeric(18, 2) NOT NULL,
	"status" varchar(10) DEFAULT 'aktif' NOT NULL,
	"tanggal_bast" date,
	"jurnal_bast_id" uuid,
	"tanggal_batal" date,
	"nominal_potongan" numeric(18, 2),
	"alasan_batal" text,
	"jurnal_batal_id" uuid,
	"nilai_cashback_kpr" numeric(18, 2),
	"nilai_admin_kpr" numeric(18, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "penjualan_keuangan_assignment_id_unique" UNIQUE("assignment_id")
);
--> statement-breakpoint
CREATE TABLE "finance"."template_dokumen" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pt_id" uuid NOT NULL,
	"jenis" varchar(20) DEFAULT 'SPPR' NOT NULL,
	"tipe_transaksi" varchar(10) NOT NULL,
	"nama" varchar(100),
	"pola_nomor" varchar(60) NOT NULL,
	"aktif" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finance"."template_pasal" (
	"template_id" uuid NOT NULL,
	"pasal_id" uuid NOT NULL,
	"urutan" smallint NOT NULL,
	CONSTRAINT "template_pasal_template_id_pasal_id_pk" PRIMARY KEY("template_id","pasal_id")
);
--> statement-breakpoint
ALTER TABLE "finance"."akun_sistem" ADD CONSTRAINT "akun_sistem_akun_id_akun_id_fk" FOREIGN KEY ("akun_id") REFERENCES "finance"."akun"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."alokasi_pembayaran" ADD CONSTRAINT "alokasi_pembayaran_payment_id_trk_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "finance"."trk_payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."alokasi_pembayaran" ADD CONSTRAINT "alokasi_pembayaran_penjualan_id_penjualan_keuangan_id_fk" FOREIGN KEY ("penjualan_id") REFERENCES "finance"."penjualan_keuangan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."alokasi_pembayaran" ADD CONSTRAINT "alokasi_pembayaran_jadwal_id_jadwal_angsuran_id_fk" FOREIGN KEY ("jadwal_id") REFERENCES "finance"."jadwal_angsuran"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."alokasi_pembayaran" ADD CONSTRAINT "alokasi_pembayaran_diubah_oleh_users_id_fk" FOREIGN KEY ("diubah_oleh") REFERENCES "finance"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."dokumen" ADD CONSTRAINT "dokumen_pt_id_master_pt_id_fk" FOREIGN KEY ("pt_id") REFERENCES "finance"."master_pt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."dokumen" ADD CONSTRAINT "dokumen_unit_id_trk_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "finance"."trk_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."dokumen" ADD CONSTRAINT "dokumen_assignment_id_trk_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "finance"."trk_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."dokumen" ADD CONSTRAINT "dokumen_template_id_template_dokumen_id_fk" FOREIGN KEY ("template_id") REFERENCES "finance"."template_dokumen"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."dokumen" ADD CONSTRAINT "dokumen_induk_id_dokumen_id_fk" FOREIGN KEY ("induk_id") REFERENCES "finance"."dokumen"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."dokumen" ADD CONSTRAINT "dokumen_difinalkan_oleh_users_id_fk" FOREIGN KEY ("difinalkan_oleh") REFERENCES "finance"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."dokumen_pasal" ADD CONSTRAINT "dokumen_pasal_dokumen_id_dokumen_id_fk" FOREIGN KEY ("dokumen_id") REFERENCES "finance"."dokumen"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."dokumen_pasal" ADD CONSTRAINT "dokumen_pasal_pustaka_id_pasal_id_fk" FOREIGN KEY ("pustaka_id") REFERENCES "finance"."pasal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."jadwal_angsuran" ADD CONSTRAINT "jadwal_angsuran_penjualan_id_penjualan_keuangan_id_fk" FOREIGN KEY ("penjualan_id") REFERENCES "finance"."penjualan_keuangan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."jadwal_angsuran" ADD CONSTRAINT "jadwal_angsuran_assignment_id_trk_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "finance"."trk_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."jadwal_angsuran" ADD CONSTRAINT "jadwal_angsuran_dokumen_id_dokumen_id_fk" FOREIGN KEY ("dokumen_id") REFERENCES "finance"."dokumen"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."pasal" ADD CONSTRAINT "pasal_pt_id_master_pt_id_fk" FOREIGN KEY ("pt_id") REFERENCES "finance"."master_pt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."penjualan_keuangan" ADD CONSTRAINT "penjualan_keuangan_assignment_id_trk_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "finance"."trk_assignments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."penjualan_keuangan" ADD CONSTRAINT "penjualan_keuangan_dokumen_id_dokumen_id_fk" FOREIGN KEY ("dokumen_id") REFERENCES "finance"."dokumen"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."penjualan_keuangan" ADD CONSTRAINT "penjualan_keuangan_jurnal_bast_id_jurnal_id_fk" FOREIGN KEY ("jurnal_bast_id") REFERENCES "finance"."jurnal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."penjualan_keuangan" ADD CONSTRAINT "penjualan_keuangan_jurnal_batal_id_jurnal_id_fk" FOREIGN KEY ("jurnal_batal_id") REFERENCES "finance"."jurnal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."template_dokumen" ADD CONSTRAINT "template_dokumen_pt_id_master_pt_id_fk" FOREIGN KEY ("pt_id") REFERENCES "finance"."master_pt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."template_pasal" ADD CONSTRAINT "template_pasal_template_id_template_dokumen_id_fk" FOREIGN KEY ("template_id") REFERENCES "finance"."template_dokumen"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."template_pasal" ADD CONSTRAINT "template_pasal_pasal_id_pasal_id_fk" FOREIGN KEY ("pasal_id") REFERENCES "finance"."pasal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alokasi_payment_idx" ON "finance"."alokasi_pembayaran" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "alokasi_penjualan_idx" ON "finance"."alokasi_pembayaran" USING btree ("penjualan_id");--> statement-breakpoint
CREATE INDEX "dokumen_assignment_idx" ON "finance"."dokumen" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "dokumen_pasal_dokumen_idx" ON "finance"."dokumen_pasal" USING btree ("dokumen_id");--> statement-breakpoint
CREATE INDEX "jadwal_penjualan_idx" ON "finance"."jadwal_angsuran" USING btree ("penjualan_id");--> statement-breakpoint
CREATE INDEX "outbox_status_idx" ON "finance"."outbox_track" USING btree ("status");