import { index, vector, pgTable, text, timestamp, boolean, integer } from "drizzle-orm/pg-core";

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
