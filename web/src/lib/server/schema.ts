import { index, vector, pgTable, text, timestamp, boolean, integer, serial } from "drizzle-orm/pg-core";

export const trackTable = pgTable(
  "track",
  {
    uri: text("uri").primaryKey(),
    name: text("name").notNull(),
    artist: text("artist").array().notNull(),
    album: text("album").notNull(),
    embedding: vector("embedding", { dimensions: 512 }),
    createdAt: timestamp("created_at", { mode: "string" }).defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow(),
    skip: boolean("skip").default(false),
    clusterId: integer("cluster_id").default(-1),
  },
  (table) => [
    index("embeddingIndex").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops")
    ),
  ]
);

export const skippedSongsTable = pgTable("skipped_songs", {
  uri: text("uri").primaryKey(),
  source: text("source").default("default"),
});

export const likedSongsTable = pgTable("liked_songs", {
  uri: text("uri").primaryKey(),
  likedAt: timestamp("liked_at", { mode: "string" }).defaultNow(),
  hour: integer("hour"), // Hour of the day (0-23)
  source: text("source"), // e.g. "vibe", "manual", "debug"
});

export const skippedArtistsTable = pgTable("skipped_artists", {
  name: text("name").primaryKey(),
});

// Frozen centroids for stable incremental clustering.
// Computed once from current assignments (see backfill), then only
// new tracks are assigned to the nearest centroid - existing
// cluster_ids never move, so names/schedules stay valid.
export const clusterCentroidTable = pgTable("cluster_centroid", {
  clusterId: integer("cluster_id").primaryKey(),
  embedding: vector("embedding", { dimensions: 512 }),
  trackCount: integer("track_count").default(0),
  updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow(),
});

// Singleton key-value store for persisted UI state (e.g. vibe picks)
export const vibeStateTable = pgTable("vibe_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(), // JSON-encoded
  updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow(),
});

// Run history for library jobs (index / sync-favorites / analyze) so results
// survive toasts and navigation — Manage shows the last run per job.
export const jobRunTable = pgTable("job_run", {
  id: serial("id").primaryKey(),
  job: text("job").notNull(),
  startedAt: timestamp("started_at", { mode: "string" }).defaultNow(),
  finishedAt: timestamp("finished_at", { mode: "string" }),
  ok: boolean("ok"),
  detail: text("detail"),
});

// Hour-range schedules mapping time-of-day -> cluster picks.
// startHour inclusive, endHour exclusive, 0-24. Wraps overnight when startHour > endHour.
export const vibeScheduleTable = pgTable("vibe_schedule", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  startHour: integer("start_hour").notNull(),
  endHour: integer("end_hour").notNull(),
  clusterIds: integer("cluster_ids").array().notNull(),
  enabled: boolean("enabled").default(true),
  createdAt: timestamp("created_at", { mode: "string" }).defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "string" }).defaultNow(),
});
