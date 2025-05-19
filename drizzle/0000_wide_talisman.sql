CREATE TABLE "track" (
	"uri" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"artist" text[] NOT NULL,
	"album" text NOT NULL,
	"embedding" vector(256)
);
--> statement-breakpoint
CREATE INDEX "embeddingIndex" ON "track" USING hnsw ("embedding" vector_cosine_ops);