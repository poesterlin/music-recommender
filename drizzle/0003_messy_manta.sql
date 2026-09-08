CREATE TABLE "cluster_centroid" (
	"cluster_id" integer PRIMARY KEY NOT NULL,
	"embedding" vector(512),
	"track_count" integer DEFAULT 0,
	"updated_at" timestamp DEFAULT now()
);
