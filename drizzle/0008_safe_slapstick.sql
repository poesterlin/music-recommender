CREATE TABLE "cluster_centroid_backup" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"cluster_id" integer NOT NULL,
	"embedding" vector(512),
	"track_count" integer,
	"embedding_space_version" integer,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "cluster_run_assignment" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"uri" text NOT NULL,
	"cluster_id" integer NOT NULL,
	"previous_cluster_id" integer,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_run_assignment_run_uri_idx" ON "cluster_run_assignment" ("run_id", "uri");
--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_centroid_backup_run_cluster_idx" ON "cluster_centroid_backup" ("run_id", "cluster_id");
--> statement-breakpoint
ALTER TABLE "cluster_run" ADD COLUMN "applied_at" timestamp;