CREATE TABLE "cluster_run" (
	"id" serial PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"mode" text DEFAULT 'benchmark' NOT NULL,
	"config" jsonb NOT NULL,
	"report" jsonb,
	"report_path" text,
	"assignments_path" text,
	"track_count" integer,
	"dimensions" integer,
	"error" text,
	"created_at" timestamp DEFAULT now(),
	"completed_at" timestamp
);
