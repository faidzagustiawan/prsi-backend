ALTER TABLE "finance"."sync_cursor" ADD COLUMN "gap_seq" bigint;--> statement-breakpoint
ALTER TABLE "finance"."sync_cursor" ADD COLUMN "gap_since" timestamp with time zone;