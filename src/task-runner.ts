import { eq, like, ilike, or, and, sql } from "drizzle-orm";
import { db } from "../web/src/lib/server/db";
import { trackTable, likedSongsTable, skippedSongsTable, skippedArtistsTable } from "../web/src/lib/server/schema";

const command = process.argv[2];
const args = process.argv.slice(3);

if (!command) {
  console.log("Usage: bun src/task-runner.ts <command> [args...]");
  console.log("");
  console.log("Commands:");
  console.log("  search <term>         Search tracks by name (case-insensitive)");
  console.log("  artist <name>         Search tracks by artist");
  console.log("  album <name>          Search tracks by album");
  console.log("  liked                 Show liked songs");
  console.log("  skipped               Show skipped songs");
  console.log("  skipped-artists       Show skipped artists");
  console.log("  query <sql>           Run raw SQL query");
  process.exit(0);
}

async function main() {
  switch (command) {
    case "search": {
      const term = args.join(" ");
      if (!term) {
        console.error("Please provide a search term.");
        process.exit(1);
      }
      const results = await db.select()
        .from(trackTable)
        .where(ilike(trackTable.name, `%${term}%`))
        .limit(50);
      console.log(JSON.stringify(results, null, 2));
      break;
    }

    case "artist": {
      const term = args.join(" ");
      if (!term) {
        console.error("Please provide an artist name.");
        process.exit(1);
      }
      const results = await db.select()
        .from(trackTable)
        .where(sql`${trackTable.artist}::text[] @> ARRAY[${term}]`)
        .limit(50);
      // Manual ilike filter since array containment is exact
      const filtered = results.filter(t =>
        t.artist.some(a => a.toLowerCase().includes(term.toLowerCase()))
      );
      console.log(JSON.stringify(filtered, null, 2));
      break;
    }

    case "album": {
      const term = args.join(" ");
      if (!term) {
        console.error("Please provide an album name.");
        process.exit(1);
      }
      const results = await db.select()
        .from(trackTable)
        .where(ilike(trackTable.album, `%${term}%`))
        .limit(50);
      console.log(JSON.stringify(results, null, 2));
      break;
    }

    case "liked": {
      const results = await db.select()
        .from(likedSongsTable)
        .innerJoin(trackTable, eq(likedSongsTable.uri, trackTable.uri));
      const mapped = results.map(r => ({
        uri: r.liked_songs.uri,
        name: r.track.name,
        artist: r.track.artist,
        album: r.track.album,
        likedAt: r.liked_songs.likedAt,
        hour: r.liked_songs.hour,
        source: r.liked_songs.source,
      }));
      console.log(JSON.stringify(mapped, null, 2));
      break;
    }

    case "skipped": {
      const results = await db.select()
        .from(skippedSongsTable)
        .innerJoin(trackTable, eq(skippedSongsTable.uri, trackTable.uri));
      const mapped = results.map(r => ({
        uri: r.skipped_songs.uri,
        name: r.track.name,
        artist: r.track.artist,
        album: r.track.album,
      }));
      console.log(JSON.stringify(mapped, null, 2));
      break;
    }

    case "skipped-artists": {
      const results = await db.select().from(skippedArtistsTable);
      console.log(JSON.stringify(results, null, 2));
      break;
    }

    case "query": {
      const rawSql = args.join(" ");
      if (!rawSql) {
        console.error("Please provide a SQL query.");
        process.exit(1);
      }
      const results = await db.execute(sql.raw(rawSql));
      console.log(JSON.stringify(results, null, 2));
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
}

main().catch(console.error);
