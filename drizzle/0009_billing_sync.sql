ALTER TABLE "finance"."jadwal_angsuran" ADD COLUMN "jenis" varchar(20) DEFAULT 'uang_muka' NOT NULL;--> statement-breakpoint
ALTER TABLE "finance"."outbox_track" ADD COLUMN "sequence" bigserial NOT NULL;--> statement-breakpoint
ALTER TABLE "finance"."status_pembayaran_si" ADD COLUMN "keputusan" varchar(20);--> statement-breakpoint
ALTER TABLE "finance"."status_pembayaran_si" ADD COLUMN "verification_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "finance"."status_pembayaran_si" ADD COLUMN "diverifikasi_oleh_si" uuid;--> statement-breakpoint
ALTER TABLE "finance"."status_pembayaran_si" ADD COLUMN "diverifikasi_pada_si" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "finance"."sync_cursor" ADD COLUMN "bootstrap" jsonb;--> statement-breakpoint
ALTER TABLE "finance"."sync_cursor" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "finance"."trk_payments" ADD COLUMN "si_jadwal_id" uuid;--> statement-breakpoint
ALTER TABLE "finance"."status_pembayaran_si" ADD CONSTRAINT "status_pembayaran_si_diverifikasi_oleh_si_users_id_fk" FOREIGN KEY ("diverifikasi_oleh_si") REFERENCES "finance"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finance"."outbox_track" ADD CONSTRAINT "outbox_track_sequence_unique" UNIQUE("sequence");