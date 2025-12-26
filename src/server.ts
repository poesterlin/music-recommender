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

    "/debug": {
      GET: async (req) => {
        const currentTrack = await getCurrentTrack();
        return new Response(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Debug Dashboard</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; }
    h1 { color: #333; }
    .section { margin: 20px 0; padding: 20px; background: #f5f5f5; border-radius: 8px; }
    .stats { display: flex; gap: 20px; }
    .stat { background: white; padding: 15px; border-radius: 4px; flex: 1; text-align: center; }
    .stat-value { font-size: 24px; font-weight: bold; color: #007bff; }
    .track-list { list-style: none; padding: 0; }
    .track-item { background: white; margin: 8px 0; padding: 12px; border-radius: 4px; }
    .track-name { font-weight: 600; color: #333; }
    .track-artists { color: #666; font-size: 14px; }
    .current-track { background: #007bff; color: white; }
    .actions { margin-top: 20px; }
    button { padding: 10px 20px; margin-right: 10px; cursor: pointer; border: none; border-radius: 4px; background: #007bff; color: white; }
    button:hover { background: #0056b3; }
    button.danger { background: #dc3545; }
    button.danger:hover { background: #a71d2a; }
  </style>
</head>
<body>
  <h1>Music Recommender Debug Dashboard</h1>
  
  <div class="section">
    <h2>Stats</h2>
    <div class="stats">
      <div class="stat">
        <div class="stat-value">${tracks.length}</div>
        <div>Total Tracks</div>
      </div>
      <div class="stat">
        <div class="stat-value">${currentTrack ? 'Playing' : 'Idle'}</div>
        <div>Status</div>
      </div>
    </div>
  </div>

  <div class="section">
    <h2>Current Track</h2>
    ${currentTrack ? `
      <div class="track-item current-track">
        <div class="track-name">${currentTrack.name || 'Unknown'}</div>
        <div class="track-artists">${currentTrack.artists?.join(', ') || 'Unknown artists'}</div>
      </div>
    ` : '<p>No track currently playing</p>'}
  </div>

  <div class="section">
    <h2>Queued Tracks</h2>
    <ul class="track-list">
      ${tracks.map((t, i) => `
        <li class="track-item">
          <div class="track-name">#${i + 1}: ${t.name}</div>
          <div class="track-artists">${t.artists.join(', ')}</div>
        </li>
      `).join('')}
    </ul>
  </div>

  <div class="section">
    <h2>Actions</h2>
    <div class="actions">
      <button onclick="fetch('/music/play', {method: 'POST'}).then(() => location.reload())">Play Tracks</button>
      <button onclick="fetch('/track/skip', {method: 'POST'}).then(() => location.reload())" class="danger">Skip Track</button>
      <button onclick="location.reload()">Refresh</button>
    </div>
  </div>

  <script>setTimeout(() => location.reload(), 30000);</script>
</body>
</html>`, { headers: { 'Content-Type': 'text/html' } });
      },
    },
  },

  // fallback for unmatched routes:
  fetch(req) {
    return new Response("Not Found", { status: 404 });
  },
});

console.log("Server running on http://localhost:3000/debug");