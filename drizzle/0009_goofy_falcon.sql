CREATE TABLE "cluster_run_match" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"cluster_id" integer NOT NULL,
	"legacy_cluster_id" integer NOT NULL,
	"legacy_name" text NOT NULL,
	"display_name" text NOT NULL,
	"overlap_count" integer NOT NULL,
	"new_cluster_count" integer NOT NULL,
	"legacy_cluster_count" integer NOT NULL,
	"confidence" real NOT NULL,
	"related_legacy_ids" integer[] NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_run_match_run_cluster_idx" ON "cluster_run_match" USING btree ("run_id","cluster_id");