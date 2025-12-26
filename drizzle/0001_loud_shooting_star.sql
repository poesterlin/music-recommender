CREATE TABLE "liked_songs" (
	"uri" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skipped_artists" (
	"name" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skipped_songs" (
	"uri" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "track" ALTER COLUMN "embedding" SET DATA TYPE vector(512);--> statement-breakpoint
ALTER TABLE "track" ADD COLUMN "created_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "track" ADD COLUMN "updated_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "track" ADD COLUMN "skip" boolean DEFAULT false;