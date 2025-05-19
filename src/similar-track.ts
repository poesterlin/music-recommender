import {
  and,
  avg,
  cosineDistance,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  notInArray,
  sql,
} from "drizzle-orm";
import { db } from "./db";
import { skippedArtistsTable, skippedSongsTable, trackTable } from "./schema";

async function fetchRelatedTracks(
  uri: string,
  limit = 20,
  excludeUris: string[] = []
) {
  const [track] = await db
    .select({
      uri: trackTable.uri,
      embedding: trackTable.embedding,
      name: trackTable.name,
      artists: trackTable.artists,
    })
    .from(trackTable)
    .where(eq(trackTable.uri, uri));

  if (!track) {
    throw new Error(`Track with URI ${uri} not found`);
  }

  if (!track.embedding) {
    throw new Error(`Track does not have an embedding yet`);
  }

  const similarity = sql<number>`1 - (${cosineDistance(
    trackTable.embedding,
    track.embedding
  )})`;

  const similarTracks = await db
    .select({
      uri: trackTable.uri,
      name: trackTable.name,
      artists: trackTable.artists,
      similarity,
    })
    .from(trackTable)
    .where(and(gt(similarity, 0.5), notInArray(trackTable.uri, excludeUris)))
    .orderBy((t) => desc(t.similarity))
    .limit(limit);

  return similarTracks;
}

async function chainSimilarSongs(uri: string, limit = 40, batchSize = 3) {
  const tracks = await fetchRelatedTracks(uri, batchSize);

  while (tracks.length < limit) {
    const last = tracks[tracks.length - 1];
    if (!last?.uri) {
      break;
    }

    const nextTracks = await fetchRelatedTracks(
      last.uri,
      batchSize,
      tracks.map((t) => t.uri)
    );
    if (nextTracks.length === 0) {
      break;
    }

    tracks.push(...nextTracks);
  }

  return tracks;
}

async function findArtists(uri: string) {
  const [track] = await db
    .select({
      artists: trackTable.artists,
      embedding: avg(trackTable.embedding),
    })
    .from(trackTable)
    .groupBy(trackTable.artists)
    .where(eq(trackTable.uri, uri));

  if (!track) {
    throw new Error(`Track with URI ${uri} not found`);
  }

  return {
    artists: track.artists,
    embedding: track.embedding as unknown as number[],
  };
}

async function findAlbum(uri: string) {
  const [track] = await db
    .select({
      embedding: avg(trackTable.embedding),
      album: trackTable.album,
    })
    .from(trackTable)
    .groupBy(trackTable.album)
    .where(eq(trackTable.uri, uri));

  if (!track) {
    throw new Error(`Track with URI ${uri} not found`);
  }

  return {
    album: track.album,
    embedding: track.embedding as unknown as number[],
  };
}

async function findSongsFromSimilarArtists(
  uri: string,
  limit = 30,
  excludeUris: string[] = []
) {
  const { embedding } = await findArtists(uri);

  if (!embedding) {
    throw new Error(`Track does not have an embedding yet`);
  }

  const similarity = sql<number>`1 - (${cosineDistance(
    trackTable.embedding,
    embedding
  )})`;

  const similarTracks = await db
    .select({
      uri: trackTable.uri,
      name: trackTable.name,
      artists: trackTable.artists,
      similarity,
    })
    .from(trackTable)
    .where(
      and(
        gt(similarity, 0.5),
        lt(similarity, 1),
        notInArray(trackTable.uri, excludeUris)
      )
    )
    .orderBy((t) => desc(t.similarity))
    .limit(limit);

  return similarTracks;
}

async function findSimilarAlbums(
  uri: string,
  limit = 30,
  excludeUris: string[] = []
) {
  const { embedding } = await findAlbum(uri);

  const similarity = sql<number>`1 - (${cosineDistance(
    trackTable.embedding,
    embedding
  )})`;

  const similarTracks = await db
    .select({
      uri: trackTable.uri,
      name: trackTable.name,
      artists: trackTable.artists,
      similarity,
    })
    .from(trackTable)
    .where(
      and(
        gt(similarity, 0.5),
        lt(similarity, 1),
        notInArray(trackTable.uri, excludeUris)
      )
    )
    .orderBy((t) => desc(t.similarity))
    .limit(limit);

  return similarTracks;
}

async function findRandomSongOfArtist(artist: string, limit: number) {
  const tracks = await db
    .select({
      uri: trackTable.uri,
      name: trackTable.name,
      artists: trackTable.artists,
      similarity: sql<number>`1`,
    })
    .from(trackTable)
    .where(eq(trackTable.artists, [artist]))
    .orderBy(() => sql`random()`)
    .limit(limit);

  return tracks;
}

function uniqueSongs(
  songs: {
    uri: string;
    name: string;
    artists: string[];
    similarity: number;
  }[]
) {
  const uniqueSongs = new Map<string, (typeof songs)[0]>();

  for (const song of songs) {
    if (!song?.uri) {
      continue;
    }
    if (!uniqueSongs.has(song.uri)) {
      uniqueSongs.set(song.uri, song);
    }
  }

  return Array.from(uniqueSongs.values());
}

async function removeLongChainOfSameArtists(
  songs: {
    uri: string;
    name: string;
    artists: string[];
    similarity: number;
  }[],
  limit: number
) {
  let lastArtists: string[] = [];
  let chainCount = 0;
  const counts: number[] = [];

  for (const song of songs) {
    if (song.artists.some((artist) => lastArtists.includes(artist))) {
      chainCount++;
    } else {
      chainCount = 1;
    }

    counts.push(chainCount);
    lastArtists = song.artists;
  }

  const skippedArtists = await db.select().from(skippedArtistsTable);

  return songs.filter((song, index) => {
    const artistSkipped = skippedArtists.some((skipped) =>
      song.artists.some((artist) => skipped.name === artist)
    );
    if (artistSkipped && Math.random() < 0.3) {
      return false;
    }

    const count = counts[index] ?? 0;
    return count <= limit;
  });
}

export async function skipTrack(uri: string) {
  const [track] = await db
    .select()
    .from(skippedSongsTable)
    .where(eq(skippedSongsTable.uri, uri));

  if (track) {
    console.log("Track already skipped", uri);
    return;
  }

  await db.insert(skippedSongsTable).values({ uri });
  console.log("Track skipped", uri);
}

export async function skipArtists(artists: string[]) {
  if (artists.length === 0) {
    console.log("No artists to skip");
    return;
  }

  await db
    .insert(skippedArtistsTable)
    .values(artists.map((artist) => ({ name: artist })))
    .onConflictDoNothing();

  console.log("Artists skipped", artists);
}

export async function getRandomTrack() {
  const [track] = await db
    .select({
      uri: trackTable.uri,
    })
    .from(trackTable)
    .where(isNotNull(trackTable.embedding))
    .orderBy(() => sql`random()`)
    .limit(1);

  if (!track) {
    throw new Error("No track found");
  }

  return track.uri;
}

export async function findSimilarTracks(uri: string) {
  const res = await Promise.all([
    chainSimilarSongs(uri),
    findSongsFromSimilarArtists(uri),
    findSimilarAlbums(uri),
    fetchRelatedTracks(uri),
  ]);

  const results = res.flat();

  let uniqueResults = await Promise.all(
    uniqueSongs(results).sort((a, b) => b.similarity - a.similarity)
  );

  // insert another track of the same artist after each track
  for (let i = uniqueResults.length - 1; i >= 0; i--) {
    const result = uniqueResults[i];
    if (!result?.artists) {
      continue;
    }

    const isNextTrackFromTheSameArtist = uniqueResults[i + 1]?.artists?.some(
      (artist) => result.artists.includes(artist)
    );

    if (isNextTrackFromTheSameArtist) {
      continue;
    }

    const isPreviousTrackFromTheSameArtist = uniqueResults[
      i - 1
    ]?.artists?.some((artist) => result.artists.includes(artist));

    let twoOrThree: number;
    if (isPreviousTrackFromTheSameArtist) {
      twoOrThree = 1;
    } else {
      twoOrThree = Math.random() < 0.5 ? 2 : 3;
    }
    const tracksFromArtist = await Promise.all(
      result.artists.map((artist) => findRandomSongOfArtist(artist, twoOrThree))
    );

    const randomTrack = tracksFromArtist.concat([result]).flat();
    const uniqueRandomTrack = uniqueSongs(randomTrack);
    uniqueResults.splice(i, 1, ...uniqueRandomTrack);
  }

  // remove duplicates
  uniqueResults = uniqueSongs(
    await removeLongChainOfSameArtists(uniqueResults, 3)
  );

  const ids = [];
  for (let i = 0; i < uniqueResults.length; i++) {
    const result = uniqueResults[i];

    if (!result?.uri) {
      console.error("No URI found for track", result);
      continue;
    }

    const [shouldSkip] = await db
      .select()
      .from(skippedSongsTable)
      .where(eq(skippedSongsTable.uri, result.uri));

    if (shouldSkip) {
      console.log("Track was skipped", result.uri);
      continue;
    }

    console.log(
      `${result.artists.join(", ")}: ${
        result.name
      }, similarity: ${result.similarity.toFixed(3)}, uri: ${result.uri}`
    );

    ids.push(result.uri);
  }

  return ids;
}
