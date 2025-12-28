import { sql } from "drizzle-orm";
import { db } from "./db";
import { recommend } from "./recomendation-engine";
import { trackTable } from "./schema";
import {
  skipArtists,
  skipTrack
} from "./similar-track";
import { getCurrentTrack, playSongs } from "./webhook";

let tracks: Array<{ uri: string; name: string; album: string; artists: string[] }> = [];

// Cluster Names based on our analysis
const CLUSTER_NAMES: Record<number, string> = 
	{
	  [-1]: "Wildcards",
	  0: "Cinematic Ambient Textures",
	  1: "Sunshine Legacy Pop",
	  2: "Pure Narrative Skits",
	  3: "Late Night Dance Pop",
	  4: "Raw Alt-Rock & Demos",
	  5: "Intimate Singer-Songwriter",
	  6: "Future Bass & Glitch",
	  7: "Sad-Girl Indie Cinema",
	  8: "Ethereal Indie Folk",
	  9: "Art-Pop Percussion",
	  10: "Modern Pop Hits",
	  11: "60s/70s Acoustic Foundations",
	  12: "High-Energy Alt-Pop Anthems",
	  13: "Experimental Soundscapes",
	  14: "Piano Soul & Brit-Pop",
	  15: "Slick Urban Crossover",
	  16: "Mainstream Radio Hits",
	  17: "Soft Acoustic Harmony",
	  18: "Sophisticated Pop Soul",
	  19: "Stadium Rock Radio",
	  20: "Melancholic Sophisti-Pop",
	  21: "Power Ballads & Pop Vocals",
	  22: "Modern Summer R&B",
	  23: "Electro-Pop Groove",
	  24: "Funk-Infused Hip-Hop",
	  25: "Quiet Indie Folk",
	  26: "Mainstage EDM Instrumentals",
	  27: "Mid-Tempo Modern Ballads",
	  28: "Theatrical Arena Rock",
	  29: "80s Adult Contemporary",
	  30: "Roots Rock Strumming",
	  31: "Punk-Pop Energizers",
	  32: "Early British Invasion",
	  33: "Neo-Soul & Downtempo",
	  34: "Space Rock & Shoegaze",
	  35: "Grunge & 90s Alternative",
	  36: "Dark Rhythmic Flow",
	  37: "Moody Indie Noir",
	  38: "Dark Dream Pop",
	  39: "Funk, Soul & Classic Groove",
	  40: "High-Intensity Pop-Punk",
	  41: "The New Atlanta Sound",
	  42: "Aggressive Lyricism",
	  43: "Moody Trap Anthems",
	  44: "Fragile Chamber Pop",
	  45: "British Rock & Roll Foundations",
	  46: "Upbeat Synth-Pop",
	  47: "Ethereal Modern Pop",
	  48: "Avant-Garde Fragments",
	  49: "Modern Adult Contemporary",
	  50: "Acoustic Rock Anthems",
	  51: "Indie-Pop Synth Crossover",
	  52: "Modern Minimalist Electronic",
	  53: "Folk-Soul Storytelling",
	  54: "Hard Rock & Post-Grunge",
	  55: "Funky Dance-Pop",
	  56: "Monophonic Vintage Rock",
	  57: "Cinematic Rap & Storytelling",
	  58: "Modern Americana & Pop",
	  59: "Lengthy Electronic Experiments",
	};

recommend({
  seedUris: [
    "library://track/532", // Billie Eilish - ocean eyes
    "library://track/7333", // The xx - On Hold
    "library://track/784", // Flume - Bring You Down,
  ],
  limit: 60,
  annPool: 800,
  alphaNow: 0.7, // bias toward seeds over liked profile
  // lambda: 0.8, // more relevance, less aggressive diversity
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

    "/api/recommend": {
      POST: async (req) => {
        const body = await req.json() as { seedUris: string[]; limit?: number };
        const recommendations = await recommend({
          seedUris: body.seedUris,
          limit: body.limit ?? 30,
          annPool: 800,
          alphaNow: 0.7,
          // lambda: 0.8,
          maxPerArtist: 1,
        });
        return Response.json({ success: true, tracks: recommendations });
      },
    },

    "/api/sample-cluster": {
      GET: async (req) => {
        const clusterId = Number(new URL(req.url).searchParams.get("clusterId") || "-1");
        const samples = await db
          .select({
            uri: trackTable.uri,
            name: trackTable.name,
            artists: trackTable.artist,
            album: trackTable.album,
          })
          .from(trackTable)
          .where(sql`${trackTable.clusterId} = ${clusterId}`)
          .orderBy(sql`random()`)
          .limit(30);

        return Response.json({ success: true, tracks: samples });
      }
    },

    "/api/clusters": {
      GET: async () => {
        // Fetch 1 random track from each cluster to act as a "Preview"
        const samples = await db
          .select({
            clusterId: trackTable.clusterId,
            uri: trackTable.uri,
            name: trackTable.name,
            artists: trackTable.artist,
            album: trackTable.album,
            similarity: sql`0`.as<number>(), // placeholder
          })
          .from(trackTable)
          .where(sql`${trackTable.clusterId} IS NOT NULL`)
          .orderBy(sql`random()`)
          // Using a simple distinct check logic or just a large sample to filter in JS
          .limit(200);

        tracks = samples;

        // Group by clusterId and take the first one found for each
        const uniqueClusters = Array.from(new Set(samples.map(s => s.clusterId)))
          .map(id => samples.find(s => s.clusterId === id))
          .sort((a, b) => (a?.clusterId || 0) - (b?.clusterId || 0));

        return Response.json(uniqueClusters);
      }
    },

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
          alphaNow: 0.7, // bias toward seeds over liked profile
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

        // Add the CSS for the cluster grid
        const clusterStyles = `
          .cluster-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 15px; margin-top: 15px; }
          .cluster-card { background: white; border: 1px solid #ddd; padding: 15px; border-radius: 8px; cursor: pointer; transition: transform 0.1s; position: relative; }
          .cluster-card:hover { transform: translateY(-3px); border-color: #007bff; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
          .cluster-id { position: absolute; top: 5px; right: 10px; font-size: 10px; color: #999; }
          .cluster-name { font-weight: bold; font-size: 14px; margin-bottom: 5px; display: block; color: #007bff; }
          .cluster-preview { font-size: 11px; color: #666; line-height: 1.2; }
        `;

        return new Response(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Debug Dashboard</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; background: #fafafa; }
    h1 { color: #333; }
    .section { margin: 20px 0; padding: 20px; background: #fff; border-radius: 8px; border: 1px solid #eee; box-shadow: 0 2px 4px rgba(0,0,0,0.02); }
    .stats { display: flex; gap: 20px; }
    .stat { background: #f8f9fa; padding: 15px; border-radius:4px; flex: 1; text-align: center; border: 1px solid #eee; }
    .stat-value { font-size: 24px; font-weight: bold; color: #007bff; }
    .track-list { list-style: none; padding: 0; }
    .track-item { background: #fdfdfd; margin: 8px 0; padding: 12px; border-radius:4px; border: 1px solid #eee; }
    .track-name { font-weight: 600; color: #333; }
    .track-artists { color: #666; font-size: 14px; }
    .current-track { background: #007bff; color: white; border: none; }
    .current-track .track-artists { color: #e0e0e0; }
    button { padding: 10px 20px; margin-right: 10px; cursor: pointer; border: none; border-radius: 4px; background: #007bff; color: white; }
    button:hover { background: #0056b3; }
    button.danger { background: #dc3545; }
    input, number { padding: 10px; margin: 10px 0; border: 1px solid #ddd; border-radius: 4px; }
    ${clusterStyles}
  </style>
</head>
<body>
  <h1>Music Recommender Debug Dashboard</h1>

  <!-- Stats Section -->
  <div class="section">
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

  <!-- Cluster Section -->
  <div class="section">
    <h2>Cluster Explorer</h2>
    <p><small>Click a cluster to generate a 30-song playlist based on that vibe.</small></p>
    <div id="cluster-grid" class="cluster-grid">Loading clusters...</div>
  </div>

  <div class="section">
    <h2>Manual Seed Recommender</h2>
    <input type="text" id="seedUri" placeholder="Enter track URI" />
    <input type="number" id="recommendLimit" value="30" style="width: 80px" />
    <button onclick="getRecommendations()">Get Recommendations</button>
  </div>

  <div id="recommendation-results" class="section" style="display:none">
    <h2 id="results-title">Results</h2>
    <div id="recommendations"></div>
  </div>

  <!-- Queue Section -->
  <div class="section">
    <h2>Active Queue</h2>
    <ul class="track-list">
      ${tracks.slice(0, 10).map((t, i) => `
        <li class="track-item">
          <div class="track-name">#${i + 1}: ${t.name}</div>
          <div class="track-artists">${t.artists.join(', ')}</div>
        </li>
      `).join('')}
      ${tracks.length > 10 ? '<li style="text-align:center; color:#999; padding: 10px;">... and ' + (tracks.length - 10) + ' more</li>' : ''}
    </ul>
  </div>

  <div class="section">
    <h2>Actions</h2>
    <button onclick="fetch('/music/play', {method: 'POST'}).then(() => location.reload())">Play Tracks</button>
    <button onclick="fetch('/track/skip', {method: 'POST'}).then(() => location.reload())" class="danger">Skip Current</button>
  </div>

  <script>
    const CLUSTER_NAMES = ${JSON.stringify(CLUSTER_NAMES)};

    // Load Clusters on Page Load
    fetch('/api/clusters')
      .then(res => res.json())
      .then(data => {
        const grid = document.getElementById('cluster-grid');
        grid.innerHTML = data.map(c => \`
          <div class="cluster-card" onclick="getRecommendations(\${c.clusterId}, '\${CLUSTER_NAMES[c.clusterId] || 'Cluster ' + c.clusterId}')">
            <span class="cluster-id">#\${c.clusterId}</span>
            <span class="cluster-name">\${CLUSTER_NAMES[c.clusterId] || 'Unknown Vibe'}</span>
            <div class="cluster-preview">
              \${c.name}
              <br> <i>\${c.artists.join(', ')}</i>
            </div>
          </div>
        \`).join('');
      });

    async function getRecommendations(id, label) {
      const limit = parseInt(document.getElementById('recommendLimit').value) || 30;

      const resultsDiv = document.getElementById('recommendation-results');
      const recDiv = document.getElementById('recommendations');
      const title = document.getElementById('results-title');
      
      resultsDiv.style.display = 'block';
      title.innerText = 'Recommendations: ' + (label || seedUri);
      recDiv.innerHTML = '<p>Generating playlist...</p>';
      resultsDiv.scrollIntoView({ behavior: 'smooth' });

      try {
        const response = await fetch('/api/sample-cluster?clusterId=' + id, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = await response.json();

        if (data.success) {
          recDiv.innerHTML = '<ul class="track-list">' + data.tracks.map((t, i) => \`
            <li class="track-item">
              <div class="track-name">#\${i + 1}: \${t.name}</div>
              <div class="track-artists">\${t.artists.join(', ')}</div>
            </li>
          \`).join('') + '</ul>';
        }
      } catch (err) {
        recDiv.innerHTML = '<p style="color:red">Error: ' + err.message + '</p>';
      }
    }
  </script>
</body>
</html>`, { headers: { 'Content-Type': 'text/html' } });
      },
    },
  },
  fetch(req) { return new Response("Not Found", { status: 404 }); }
});

console.log("Server running on http://localhost:3000/debug");
