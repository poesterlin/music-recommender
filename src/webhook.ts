import { env } from "bun";
import { authHeaders } from "./auth";

export async function playSongs(ids: string[]) {
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
  const raw = JSON.stringify({
    entity_id: "media_player.smart_amp_5_19677_2",
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

  const data = (await res.json()) as QueueApiResponse;
  const speakers = Object.values(data.service_response);

  for (const speaker of speakers) {
    if (!speaker.active) {
      continue;
    }

    if (!speaker.current_item?.media_item) {
      continue;
    }

    const item = speaker.current_item.media_item;
    const artists = item.artists.map((artist) => artist.name);

    return {
      uri: item.uri,
      name: item.name,
      album: item.album,
      artists,
    };
  }
}
