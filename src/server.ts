import { recommend } from "./recomendation-engine";
import {
  skipArtists,
  skipTrack
} from "./similar-track";
import { getCurrentTrack, playSongs } from "./webhook";

let tracks: Array<{ uri: string; name: string; album: string; artists: string[] }> = [];

recommend({
  seedUris: [
    "library://track/532", // Billie Eilish - ocean eyes
    "library://track/7333", // The xx - On Hold
    "library://track/784", // Flume - Bring You Down,
  ],
  limit: 60,
  annPool: 800,
  alphaNow: 0.7, // bias toward the seeds over liked profile
  lambda: 0.8, // more relevance, less aggressive diversity
  maxPerArtist: 1, // avoid clustering by same artist
}).then((result) => {
  tracks = result;
  console.log("Tracks ready for playback:", tracks.length);
}).catch((error) => {
  console.error("Error generating tracks:", error);
});

Bun.serve({
  port: 3000,
  routes: {
    "/api/status": new Response("OK"),

    "/track/skip": {
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
        // play cached tracks
        const ids = tracks.map((t) => t.uri);
        await playSongs(ids);

        // prepare next tracks
        recommend({
          seedUris: [
            "library://track/532", // Billie Eilish - ocean eyes
            "library://track/7333", // The xx - On Hold
            "library://track/784", // Flume - Bring You Down,
          ],
          limit: 60,
          annPool: 800,
          alphaNow: 0.7, // bias toward the seeds over liked profile
          lambda: 0.8, // more relevance, less aggressive diversity
          maxPerArtist: 1, // avoid clustering by same artist
        }).then((result) => {
          tracks = result;
          console.log("Tracks ready for playback:", tracks.length);
        }).catch((error) => {
          console.error("Error generating tracks:", error);
        });

        return Response.json({ success: true, tracks });
      },
    },
  },

  // fallback for unmatched routes:
  fetch(req) {
    return new Response("Not Found", { status: 404 });
  },
});
