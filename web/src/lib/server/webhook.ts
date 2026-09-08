import { eq } from "drizzle-orm";
import { authHeaders } from "./auth";
import { db } from "./db";
import { trackTable } from "./schema";
import { withMa } from "./ma-client";

const env = process.env;

// Queue shapes for the legacy Home Assistant fallback path
// (HA music_assistant/get_queue service response).
interface QueueApiResponse {
  service_response: Record<string, MediaPlayerQueue | unknown[]>;
}

interface MediaPlayerQueue {
  active: boolean;
  current_item?: {
    media_item: {
      uri: string;
      name: string;
      album: { name: string };
      artists: { name: string }[];
    };
  } | null;
}

const QUEUE_ERROR_LOG_INTERVAL_MS = 60_000;
let lastQueueErrorLogAt = 0;
let suppressedQueueErrorCount = 0;

function logQueueError(message: string, details?: string) {
  const now = Date.now();
  const shouldLogNow = now - lastQueueErrorLogAt >= QUEUE_ERROR_LOG_INTERVAL_MS;

  if (!shouldLogNow) {
    suppressedQueueErrorCount += 1;
    return;
  }

  if (suppressedQueueErrorCount > 0) {
    console.warn(`Suppressed ${suppressedQueueErrorCount} repeated queue errors`);
    suppressedQueueErrorCount = 0;
  }

  console.error(message);
  if (details) {
    console.error(details);
  }
  lastQueueErrorLogAt = now;
}

export async function playSongs(ids: string[]) {
  // Direct Music Assistant playback (native WS API). Falls back to the
  // legacy Home Assistant webhook only when MA is unreachable.
  try {
    const { playUris } = await import("./player");
    await playUris(ids);
    console.log(`Playing ${ids.length} songs via Music Assistant`);
    return;
  } catch (e) {
    console.error("MA playback failed, trying HA webhook fallback: " + String(e));
  }

  if (!env.WEBHOOK_URL) {
    console.error("WEBHOOK_URL is not set");
    return;
  }

  const resp = await fetch(env.WEBHOOK_URL!, {
    method: "POST",
    body: JSON.stringify({
      media_ids: ids,
    }),
    headers: authHeaders,
    redirect: "follow",
  });

  if (!resp.ok) {
    console.error("Failed to send webhook", await resp.text());
  }

  console.log("Webhook sent successfully", await resp.text());
}

export type CurrentTrack = {
  uri: string;
  name: string;
  album: string;
  artists: string[];
  clusterId?: number | null;
  speaker?: string;
};

async function enrichWithCluster(track: Omit<CurrentTrack, "clusterId">): Promise<CurrentTrack> {
  const [dbTrack] = await db
    .select()
    .from(trackTable)
    .where(eq(trackTable.uri, track.uri));

  if (dbTrack) {
    return {
      uri: dbTrack.uri,
      name: dbTrack.name,
      album: dbTrack.album,
      artists: dbTrack.artist,
      clusterId: dbTrack.clusterId,
      speaker: track.speaker,
    };
  }
  return track;
}

/** Now-playing straight from Music Assistant (players/all -> current_media). */
async function getCurrentTrackFromMA(): Promise<CurrentTrack | null> {
  const preferred = process.env.MA_PLAYER_NAME ?? "Wohnzimmer";
  return withMa(async (call) => {
    const players: any[] = await call("players/all");
    const withMedia = players.filter((p) => p?.current_media?.uri);
    if (!withMedia.length) return null;
    const pick =
      withMedia.find((p) => p.name === preferred && (p.state === "playing" || p.state === "paused")) ??
      withMedia.find((p) => p.state === "playing") ??
      withMedia.find((p) => p.state === "paused") ??
      withMedia[0];
    const cm = pick.current_media;
    if (cm.media_type && cm.media_type !== "track") return null;
    return enrichWithCluster({
      uri: String(cm.uri),
      name: String(cm.title ?? "Unknown"),
      album: String(cm.album ?? ""),
      artists: typeof cm.artist === "string" && cm.artist ? [cm.artist] : [],
      speaker: String(pick.name ?? pick.player_id),
    });
  });
}

export async function getCurrentTrack(): Promise<CurrentTrack | null> {
  try {
    return await getCurrentTrackFromMA();
  } catch (e) {
    logQueueError("MA now-playing failed, falling back to Home Assistant: " + String(e));
    return getCurrentTrackFromHA();
  }
}

async function getCurrentTrackFromHA(): Promise<CurrentTrack | null> {
  try {
    const raw = JSON.stringify({
      entity_id: "media_player.living_room"
    });

    const res = await fetch(
      env.HOST + "/api/services/music_assistant/get_queue?return_response",
      {
        method: "POST",
        headers: authHeaders,
        body: raw,
        redirect: "follow",
      }
    );

    if (!res.ok) {
          const errorText = await res.text();
          logQueueError(
            `Failed to fetch queue: ${res.status}`,
            errorText.includes("Server got itself") ? undefined : errorText,
          );
      return null;
    }

    const text = await res.text();
    let data: QueueApiResponse;
    try {
      data = JSON.parse(text) as QueueApiResponse;
    } catch (error) {
      logQueueError(
        "Failed to parse JSON response: " + String(error),
        "Response text: " + text,
      );
      return null;
    }

    const serviceResponse = data.service_response;
    const entries = Object.entries(serviceResponse);

    for (const [speakerName, responseValue] of entries) {
      if (Array.isArray(responseValue)) continue;

      const speaker = responseValue as MediaPlayerQueue;
      if (!speaker.active || !speaker.current_item?.media_item) continue;

      const uri = speaker.current_item.media_item.uri;

      const [dbTrack] = await db
        .select()
        .from(trackTable)
        .where(eq(trackTable.uri, uri));

      if (dbTrack) {
        return {
          uri: dbTrack.uri,
          name: dbTrack.name,
          album: dbTrack.album,
          artists: dbTrack.artist,
          clusterId: dbTrack.clusterId,
          speaker: speakerName,
        };
      }

      return {
        uri: speaker.current_item.media_item.uri,
        name: speaker.current_item.media_item.name,
        album: speaker.current_item.media_item.album.name,
        artists: speaker.current_item.media_item.artists.map(a => a.name),
        speaker: speakerName,
      };
    }
    return null;
  } catch (e) {
    logQueueError("Error fetching current track: " + String(e));
    return null;
  }
}
