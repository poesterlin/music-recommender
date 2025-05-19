import {
  findSimilarTracks,
  getRandomTrack,
  skipArtists,
  skipTrack,
} from "./similar-track";
import { getCurrentTrack, playSongs } from "./webhook";

Bun.serve({
  port: 3000,
  routes: {
    "/api/status": new Response("OK"),

    "/music/skip": {
      POST: async (req) => {
        const state = await getCurrentTrack();
        if (!state) {
          return new Response("No track found", { status: 404 });
        }

        await skipTrack(state.uri);
        await skipArtists(state.artists);

        return Response.json({ success: true });
      },
    },

    "/music/play": {
      GET: async (req) => {
        const state = await getCurrentTrack();
        if (!state) {
          return new Response("No track found", { status: 404 });
        }
        return Response.json({
          uri: state.uri,
          artists: state.artists,
        });
      },
      POST: async (req) => {
        const uri = await getRandomTrack();
        const ids = await findSimilarTracks(uri);
        await playSongs(ids);

        return Response.json({ success: true });
      },
    },
  },

  // fallback for unmatched routes:
  fetch(req) {
    return new Response("Not Found", { status: 404 });
  },
});
