CREATE TABLE "vibe_schedule" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"start_hour" integer NOT NULL,
	"end_hour" integer NOT NULL,
	"cluster_ids" integer[] NOT NULL,
	"enabled" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "vibe_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "liked_songs" ADD COLUMN "liked_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "liked_songs" ADD COLUMN "hour" integer;--> statement-breakpoint
ALTER TABLE "liked_songs" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "skipped_songs" ADD COLUMN "source" text DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "track" ADD COLUMN "cluster_id" integer DEFAULT -1;