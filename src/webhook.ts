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
      entity: "media_player.gruppe_dynamic"
    });

    const res = await fetch(
      env.HOST + "/api/services/mass_queue/get_queue_items?return_response",
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
      let uri: string | undefined;
      let fallbackInfo: any;

      if (Array.isArray(responseValue)) {
        if (responseValue.length === 0) continue;
        const firstItem = responseValue[0];
        uri = firstItem.media_content_id;
        fallbackInfo = {
          uri: firstItem.media_content_id,
          name: firstItem.media_title,
          album: firstItem.media_album_name,
          artists: [firstItem.media_artist],
          speaker: speakerName,
        };
      } else {
        const speaker = responseValue;
        if (!speaker.active || !speaker.current_item?.media_item) continue;
        uri = speaker.current_item.media_item.uri;
        fallbackInfo = {
          uri: speaker.current_item.media_item.uri,
          name: speaker.current_item.media_item.name,
          album: speaker.current_item.media_item.album,
          artists: speaker.current_item.media_item.artists.map(a => a.name),
          speaker: speakerName,
        };
      }

      if (uri) {
        // Try to get enriched info from DB
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
        return fallbackInfo;
      }
    }
  } catch (e) {
    console.error("Error fetching current track:", e);
    return null;
  }
}
