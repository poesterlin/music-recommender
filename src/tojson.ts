import { isNotNull, isNull } from "drizzle-orm";
import { db } from "./db";
import { trackTable } from "./schema";

const missing = await db
.select({
  uri: trackTable.uri,
  name: trackTable.name,
  artists: trackTable.artists,
  album: trackTable.album,
})
.from(trackTable)
.where(isNull(trackTable.embedding));

let json = JSON.stringify(missing, null, 2);
await Bun.file("output/tracks.json").write(json);

const completed = await db
  .select({
    uri: trackTable.uri,
    name: trackTable.name,
    artists: trackTable.artists,
    album: trackTable.album,
    embedding: trackTable.embedding,
  })
  .from(trackTable)
  .where(isNotNull(trackTable.embedding));

json = JSON.stringify(completed, null, 2);
await Bun.file("output/completed.json").write(json);

console.log("Completed: ", completed.length, " tracks of ", missing.length, " missing");