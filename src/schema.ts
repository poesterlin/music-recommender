import { index, vector, pgTable, text } from "drizzle-orm/pg-core";

export const trackTable = pgTable(
  "track",
  {
    uri: text("uri").primaryKey(),
    name: text("name").notNull(),
    artists: text("artist").array().notNull(),
    album: text("album").notNull(),
    embedding: vector("embedding", { dimensions: 512 }),
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
});

export const skippedArtistsTable = pgTable("skipped_artists", {
  name: text("name").primaryKey(),
});
