import { env } from "bun";
import { eq } from "drizzle-orm";
import { authHeaders } from "./auth";
import { db } from "./db";
import { trackTable } from "./schema";

export async function playSongs(ids: string[]) {
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

export async function getCurrentTrack() {
  try {
    const raw = JSON.stringify({
      entity_id: "media_player.gruppe_dynamic"
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

    const text = await res.text();
    const data = JSON.parse(text) as QueueApiResponse;
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
    console.error("Error fetching current track:", e);
    return null;
  }
}
