CREATE TABLE IF NOT EXISTS "job_run" (
	"id" serial PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"started_at" timestamp DEFAULT now(),
	"finished_at" timestamp,
	"ok" boolean,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "embedding_space" (
	"version" integer PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"mean_embedding" vector(512) NOT NULL,
	"track_count" integer NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "track" ADD COLUMN "embedding_centered" vector(512);--> statement-breakpoint
ALTER TABLE "track" ADD COLUMN "embedding_space_version" integer;--> statement-breakpoint
CREATE INDEX "embeddingCenteredIndex" ON "track" USING hnsw ("embedding_centered" vector_cosine_ops);