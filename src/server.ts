import { sql, inArray, and, eq } from "drizzle-orm";
import { db } from "./db";
import { recommend, validateTrackUris } from "./recomendation-engine";
import { likedSongsTable, trackTable } from "./schema";
import {
  skipTrack,
  likeTrack
} from "./similar-track";
import { getCurrentTrack, playSongs } from "./webhook";
import { syncFavorites } from "./sync-favourites";
import { indexLibrary } from "./index-library";
import { startWLEDVisualization } from "./wled-visualizer";
import { addArtistByNameToLidarr, ARTISTS_TO_ADD, importArtistsToLidarr } from "./add-artists";
import { env } from "bun";
import {
  createSchedule,
  deleteSchedule,
  ensureVibeSeeded,
  getActiveSchedule,
  getVibeClusterIds,
  listSchedules,
  setVibeClusterIds,
  updateSchedule,
} from "./vibe-store";

let tracks: Array<{ uri: string; name: string; album: string; artists: string[] }> = [];

await ensureVibeSeeded();

// Cluster Names based on our analysis
const CLUSTER_NAMES: Record<number, string> = {
  [-1]: "Wildcards",
  0: "Skits, Interludes & Hip-Hop Bits",
  1: "Emotive Pop & Classic Anthems",
  2: "Smooth Grooves & Global Pop",
  3: "Cinematic & Atmospheric Pop",
  4: "German Pop & Boy Band Classics",
  5: "Eclectic Rock & Instrumental Textures",
  6: "Sophisticated Pop & Easy Listening",
  7: "Energetic Rock & Post-Grunge",
  8: "Classic Legends & Introspective Folk",
  9: "Modern R&B & Contemporary Pop",
  10: "Emotional Ballads & Indie Folk",
  11: "Moody Alternative & R&B",
  12: "2000s Radio Rock & Pop-Rap",
  13: "Britpop, Punk & Energetic Alt",
  14: "High-Energy Dance & Club Pop",
  15: "Uplifting Pop-Rock & Catchy Hits",
  16: "Atmospheric Hip-Hop & Ethereal Pop",
  17: "Vintage Rock & Psychedelic 60s/70s",
  18: "Mainstream Pop & Big Radio Hits",
  19: "80s Pop-Rock & Melodic Legends",
  20: "Modern Pop & Chill Trap-Pop",
  21: "Quirky Pop & Modern Synth-Pop",
  22: "Funky Hip-Hop & Rap-Pop",
  23: "Melodic R&B & Contemporary Breezy Pop",
  24: "Hard-Hitting Hip-Hop & Urban Dance",
  25: "Vintage Pop & Clean Melodic Hits",
  26: "Intense Rock-Rap & Dramatic Vibe",
  27: "Whimsical Indie-Pop & Soft Acoustic",
  28: "Modern Eclectic Pop & Smooth Vocals",
  29: "Aggressive Rock & Punk Energy",
  30: "Sophisticated Electronic & New Wave",
  31: "Stripped-Back Vocals & Piano Ballads",
  32: "High-Octane Rock & Stadium Anthems",
  33: "Graceful & Orchestral Pop",
  34: "Deep House & Groovy Club Beats",
  35: "Gentle Indie-Folk & Soft Vintage Rock",
  36: "Moody Dream Pop & Atmospheric Indie",
  37: "Artistic & Cinematic Pop-R&B",
  38: "Upbeat Pop-Rock & Classic Hooks",
  39: "Raw Acoustic & Bluesy Folk",
  40: "Dark R&B & Ethereal Soul",
  41: "Symphonic Pop & Dramatic Ballads",
  42: "Hard EDM & Aggressive Techno-Pop",
  43: "Indie Rock & Modern Driving Pop",
  44: "Fast-Flow Hip-Hop & Trap Energy",
  45: "Modern Pop-R&B Fusion",
  46: "Singer-Songwriter & Modern Emotional Pop",
  47: "Progressive & Complex Rock",
  48: "Polished 90s/00s Melodic Rock",
  49: "Theatrical Rock & Arena Anthems",
  50: "Charismatic Pop & Timeless Grooves",
  51: "Party EDM & Hands-Up Dance",
  52: "Orchestral & Grandiose Arrangements",
  53: "Acoustic Rock & Vulnerable Pop",
  54: "Psychedelic Pop & Experimental Indie",
  55: "Art-Pop & Funky New Wave",
  56: "Radio-Friendly Pop-Rock Hits",
  57: "Urban Classics & Funky Rap",
  58: "Emotive Modern Pop & Cinematic Beats",
  59: "Garage Rock & Upbeat Indie",
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
}).then(async (result) => {
  tracks = await validateTrackUris(result);
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
          maxPerArtist: 3,
        });
        tracks = await validateTrackUris(recommendations);
        return Response.json({ success: true, tracks });
      },
    },

    "/api/search": {
      GET: async (req) => {
        const query = new URL(req.url).searchParams.get("q");
        if (!query) return Response.json({ success: true, tracks: [] });

        const matches = await db
          .select({
            uri: trackTable.uri,
            name: trackTable.name,
            artists: trackTable.artist,
          })
          .from(trackTable)
          .where(sql`${trackTable.name} ILIKE ${"%" + query + "%"}`)
          .limit(10);

        return Response.json({ success: true, tracks: matches });
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
        // await skipArtists(state.artists);

        return Response.json({ success: true });
      },
    },

    "/track/like": {
      POST: async (req) => {
        const body = await req.json().catch(() => ({}));
        const state = await getCurrentTrack();
        if (!state) {
          return new Response("No track found", { status: 404 });
        }

        await likeTrack(state.uri, (body as any).source || "manual");

        return Response.json({ success: true, name: state.name });
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
        // validate and play cached tracks
        const validated = await validateTrackUris(tracks);
        const ids = validated.map((t) => t.uri);
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
        }).then(async (result) => {
          tracks = await validateTrackUris(result);
          console.log("Tracks ready for playback:", tracks.length);
        }).catch((error) => {
          console.error("Error generating tracks:", error);
        });

        return Response.json({ success: true, tracks: validated });
      },
    },

    "/api/index-library": {
      POST: async () => {
        try {
          const count = await indexLibrary();
          return Response.json({ success: true, count });
        } catch (error) {
          console.error("Index library failed:", error);
          return Response.json({ success: false, error: String(error) }, { status: 500 });
        }
      },
    },

    "/api/sync-favorites": {
      POST: async () => {
        try {
          const count = await syncFavorites();
          return Response.json({ success: true, count });
        } catch (error) {
          console.error("Sync favorites failed:", error);
          return Response.json({ success: false, error: String(error) }, { status: 500 });
        }
      },
    },

    "/api/analyze": {
      POST: async () => {
        try {
          // 0. Ask Music Assistant to sync its providers (e.g. Plex) so new
          // downloads show up. Skipped (not failed) when MA_TOKEN is unset.
          let maSync: unknown = { skipped: true };
          if (process.env.MA_TOKEN) {
            const { triggerLibrarySync } = await import("./ma-sync");
            maSync = await triggerLibrarySync();
          } else {
            console.warn("[analyze] MA_TOKEN not set, skipping MA library sync");
          }
          // 1. Pull new tracks from Music Assistant (no embeddings yet)
          const indexed = await indexLibrary();
          // 2. Assign embedded-but-unclustered tracks to frozen centroids.
          // Existing cluster_ids are never touched. Audio embedding
          // generation itself runs in the embeddings-loop container.
          const { assignNewTracksToClusters } = await import("./clustering");
          const assigned = await assignNewTracksToClusters();
          return Response.json({ success: true, maSync, indexed, assigned });
        } catch (error) {
          console.error("Analyze failed:", error);
          return Response.json({ success: false, error: String(error) }, { status: 500 });
        }
      },
    },

    "/api/play-vibe": {
      GET: async () => {
        const [clusterIds, schedules, active] = await Promise.all([
          getVibeClusterIds(),
          listSchedules(),
          getActiveSchedule(),
        ]);
        return Response.json({ success: true, clusterIds, names: CLUSTER_NAMES, schedules, activeSchedule: active });
      },
      POST: async (req) => {
        try {
          const body = await req.json().catch(() => ({})) as { clusterIds?: number[]; useSchedule?: boolean; saveOnly?: boolean };
          let clusterIds: number[];
          let activeSchedule = null;
          if (body.useSchedule) {
            activeSchedule = await getActiveSchedule();
            clusterIds = activeSchedule?.clusterIds?.length ? [...activeSchedule.clusterIds] : await getVibeClusterIds();
          } else if (Array.isArray(body.clusterIds) && body.clusterIds.length > 0) {
            clusterIds = await setVibeClusterIds(body.clusterIds);
          } else {
            clusterIds = await getVibeClusterIds();
          }
          if (body.saveOnly) {
            return Response.json({ success: true, clusterIds, saved: true });
          }

          // Select 5 random tracks from these clusters as seeds
          const seeds = await db
            .select({ uri: trackTable.uri })
            .from(trackTable)
            .innerJoin(likedSongsTable, eq(trackTable.uri, likedSongsTable.uri))
            .where(and(inArray(trackTable.clusterId, clusterIds), eq(trackTable.skip, false)))
            .orderBy(sql`random()`)
            .limit(5);

          const recommendations = await recommend({
            seedUris: seeds.map(s => s.uri),
            limit: 50,
            annPool: 800,
            alphaNow: 0.8,
            maxPerArtist: 4,
            clusterIds,
          });

          if (recommendations.length > 0) {
            tracks = await validateTrackUris(recommendations);
            await playSongs(tracks.map(t => t.uri));
            return Response.json({ success: true, tracks });
          } else {
            return Response.json({ success: false, error: "No recommendations generated" }, { status: 500 });
          }
        } catch (error) {
          console.error("Vibe playback failed:", error);
          return Response.json({ success: false, error: String(error) }, { status: 500 });
        }
      },
    },

    "/api/vibe-schedules": {
      GET: async () => {
        const [schedules, active] = await Promise.all([listSchedules(), getActiveSchedule()]);
        return Response.json({ success: true, schedules, activeSchedule: active });
      },
      POST: async (req) => {
        try {
          const body = await req.json() as { name?: string; startHour?: number; endHour?: number; clusterIds?: number[]; enabled?: boolean };
          const row = await createSchedule({
            name: body.name ?? "",
            startHour: Number(body.startHour),
            endHour: Number(body.endHour),
            clusterIds: body.clusterIds ?? [],
            enabled: body.enabled,
          });
          return Response.json({ success: true, schedule: row });
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 400 });
        }
      },
      PUT: async (req) => {
        try {
          const body = await req.json() as { id?: number; name?: string; startHour?: number; endHour?: number; clusterIds?: number[]; enabled?: boolean };
          if (!Number.isInteger(body.id)) return Response.json({ success: false, error: "id is required" }, { status: 400 });
          const row = await updateSchedule(body.id as number, {
            name: body.name,
            startHour: body.startHour !== undefined ? Number(body.startHour) : undefined,
            endHour: body.endHour !== undefined ? Number(body.endHour) : undefined,
            clusterIds: body.clusterIds,
            enabled: body.enabled,
          });
          if (!row) return Response.json({ success: false, error: "Not found" }, { status: 404 });
          return Response.json({ success: true, schedule: row });
        } catch (error) {
          return Response.json({ success: false, error: String(error) }, { status: 400 });
        }
      },
      DELETE: async (req) => {
        const id = Number(new URL(req.url).searchParams.get("id"));
        if (!Number.isInteger(id)) return Response.json({ success: false, error: "id is required" }, { status: 400 });
        await deleteSchedule(id);
        return Response.json({ success: true });
      },
    },

    "/api/lidarr/add-artist": {
      POST: async (req) => {
        try {
          const body = await req.json() as { name?: string };
          const artistName = body.name?.trim();

          if (!artistName) {
            return Response.json(
              { success: false, message: "Artist name is required" },
              { status: 400 },
            );
          }

          const result = await addArtistByNameToLidarr(artistName);
          return Response.json(result, { status: result.success ? 200 : 500 });
        } catch (error) {
          return Response.json(
            { success: false, message: "Invalid request body", error: String(error) },
            { status: 400 },
          );
        }
      },
    },

    "/api/lidarr/import-default-artists": {
      POST: async () => {
        try {
          const result = await importArtistsToLidarr(ARTISTS_TO_ADD);
          return Response.json({
            success: true,
            imported: result.success,
            failed: result.failed,
            results: result.results,
          });
        } catch (error) {
          return Response.json(
            { success: false, message: "Failed to import artists", error: String(error) },
            { status: 500 },
          );
        }
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
          .cluster-card.active-family { border-color: #28a745; background: #f8fff9; box-shadow: 0 0 10px rgba(40, 167, 69, 0.2); }
          .cluster-card.active-family::after { content: 'Current Family'; position: absolute; bottom: 5px; right: 8px; font-size: 9px; color: #28a745; font-weight: bold; text-transform: uppercase; }
          .cluster-id { position: absolute; top: 5px; right: 10px; font-size: 10px; color: #999; }
          .cluster-name { font-weight: bold; font-size: 14px; margin-bottom: 5px; display: block; color: #007bff; }
          .active-family .cluster-name { color: #28a745; }
          .cluster-preview { font-size: 11px; color: #666; line-height: 1.2; }
        `;

        const hour = new Date().getHours();
        let currentFamily: number[] = [2];
        if (hour >= 6 && hour < 10) currentFamily.push(10, 16, 26, 38, 54);
        // else if (hour >= 10 && hour < 18) currentFamily.push(1, 10, 16, 18, 22, 58, 49);
        else if (hour >= 18 && hour < 22) currentFamily.push(2, 20, 18, 47);
        else currentFamily.push(41, 46, 50, 56);

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

  <!-- Now Playing Section -->
  ${currentTrack ? `
  <div class="section">
    <h2>Now Playing ${(currentTrack as any).speaker ? `<small style="font-size: 12px; color: #666; font-weight: normal; margin-left: 10px;">on ${(currentTrack as any).speaker}</small>` : ''}</h2>
    <div class="track-item current-track">
      <div class="track-name" style="font-weight: 600; color: #fff;">${currentTrack.name}</div>
      <div class="track-artists">${currentTrack.artists.join(', ')}</div>
      <div style="font-size: 11px; margin-top: 4px; opacity: 0.8;">${currentTrack.album}</div>
      ${(currentTrack as any).clusterId !== undefined ? `<div style="font-size: 12px; margin-top: 8px; font-weight: bold; color: #fff; background: rgba(255,255,255,0.2); display: inline-block; padding: 2px 8px; border-radius: 4px;">Vibe: ${CLUSTER_NAMES[(currentTrack as any).clusterId] || 'Cluster ' + (currentTrack as any).clusterId}</div>` : ''}
    </div>
    <div style="margin-top: 15px;">
      <button onclick="fetch('/track/like', {method: 'POST', body: JSON.stringify({source: 'debug'}), headers: {'Content-Type': 'application/json'}}).then(() => alert('Liked!'))" style="background: #28a745;">Like Song</button>
      <button onclick="fetch('/track/skip', {method: 'POST'}).then(() => location.reload())" class="danger">Skip</button>
    </div>
  </div>
  ` : ''}

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
    <h2>Vibe Mix — Picked Clusters</h2>
    <p><small>Persists to DB on Save/Play. Survives restarts.</small></p>
    <div id="active-slot" style="margin-bottom: 10px; font-size: 13px; color: #28a745;"></div>
    <div style="margin-bottom: 10px;">
      <button onclick="setAllVibe(true)" style="background: #6c757d; padding: 6px 12px;">Select all</button>
      <button onclick="setAllVibe(false)" style="background: #6c757d; padding: 6px 12px;">Clear</button>
      <button onclick="loadActiveSlot()" style="background: #6c757d; padding: 6px 12px;">Load current slot</button>
      <span id="vibe-count" style="margin-left: 10px; color: #666; font-size: 13px;"></span>
    </div>
    <div id="vibe-picker" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 6px; max-height: 300px; overflow-y: auto; border: 1px solid #eee; padding: 10px; border-radius: 4px;"></div>
    <div style="margin-top: 12px;">
      <button onclick="saveVibeSelection()" style="background: #6c757d;">Save picks</button>
      <button onclick="playVibeWithSelection()" style="background: #28a745;">Play Vibe with selection</button>
      <button onclick="playScheduledVibe()" style="background: #17a2b8;">Play scheduled slot</button>
    </div>
    <div id="vibe-save-status" style="margin-top: 8px; font-size: 13px; color: #666;"></div>
  </div>

  <div class="section">
    <h2>Vibe Schedule</h2>
    <p><small>Hour ranges (0-24, wraps overnight e.g. 22-6). The active slot is highlighted in the picker above.</small></p>
    <div id="schedule-list">Loading schedules...</div>
    <h3 style="margin-top: 16px;">Add slot</h3>
    <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
      <input type="text" id="schedName" placeholder="Name (e.g. Morning)" style="width: 140px;" />
      <label style="font-size: 13px;">From <input type="number" id="schedStart" min="0" max="24" value="6" style="width: 60px;" /></label>
      <label style="font-size: 13px;">To <input type="number" id="schedEnd" min="0" max="24" value="10" style="width: 60px;" /></label>
      <input type="text" id="schedClusters" placeholder="clusters e.g. 2,10,16" style="width: 180px;" />
      <button onclick="createSchedule()" style="padding: 6px 12px;">Add</button>
    </div>
    <p><small>Tip: clusters = current picker selection if left blank.</small></p>
  </div>

  <div class="section">
    <h2>Cluster Explorer</h2>
    <p><small>Click a cluster to generate a 30-song playlist based on that vibe.</small></p>
    <div id="cluster-grid" class="cluster-grid">Loading clusters...</div>
  </div>

  <div class="section">
    <h2>Manual Seed Recommender</h2>
    <input type="text" id="seedSearch" placeholder="Enter track name" />
    <input type="number" id="recommendLimit" value="30" style="width: 80px" />
    <button onclick="getRecommendations()">Get Recommendations</button>
  </div>

  <div id="recommendation-results" class="section" style="display:none">
    <h2 id="results-title">Results</h2>
    <div id="recommendations"></div>
  </div>

  <div class="section">
    <h2>Lidarr Artist Tools</h2>
    <p><small>Add one artist by name, or import the default curated list (${ARTISTS_TO_ADD.length} artists).</small></p>
    <input type="text" id="artistName" placeholder="Artist name (e.g. Sampha)" />
    <button onclick="addArtistToLidarrFromDebug()" style="background: #6c757d;">Add Artist</button>
    <div id="lidarr-results" style="margin-top: 12px; color: #444;"></div>
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
    <button onclick="playVibeWithSelection()" style="background: #28a745;">Play Vibe</button>
    <button onclick="fetch('/music/play', {method: 'POST'}).then(() => location.reload())">Play Queue</button>
    <button onclick="fetch('/track/skip', {method: 'POST'}).then(() => location.reload())" class="danger">Skip Current</button>
  </div>

  <script>
    const CLUSTER_NAMES = ${JSON.stringify(CLUSTER_NAMES)};
    const CURRENT_FAMILY = ${JSON.stringify(currentFamily)};

    let vibeSelection = new Set();
    let vibeSchedules = [];
    let activeSchedule = null;

    function updateVibeCount() {
      const el = document.getElementById('vibe-count');
      if (el) el.innerText = vibeSelection.size + ' picked';
    }

    function clusterLabel(id) {
      return '#' + id + ' ' + (CLUSTER_NAMES[id] || 'Cluster ' + id);
    }

    function renderVibePicker(ids) {
      vibeSelection = new Set(ids);
      const picker = document.getElementById('vibe-picker');
      picker.innerHTML = Object.keys(CLUSTER_NAMES).map(k => {
        const id = Number(k);
        const checked = vibeSelection.has(id) ? 'checked' : '';
        return '<label style="font-size: 13px; display: flex; gap: 6px; align-items: center; background: #f8f9fa; padding: 4px 8px; border-radius: 4px; cursor: pointer;">' +
          '<input type="checkbox" data-vibe-id="' + id + '" ' + checked + ' onchange="toggleVibe(' + id + ', this.checked)" />' +
          '<span><b>#' + id + '</b> ' + CLUSTER_NAMES[k] + '</span></label>';
      }).join('');
      updateVibeCount();
    }

    function toggleVibe(id, on) {
      if (on) vibeSelection.add(id);
      else vibeSelection.delete(id);
      updateVibeCount();
    }

    function setAllVibe(on) {
      vibeSelection = on ? new Set(Object.keys(CLUSTER_NAMES).map(Number)) : new Set();
      document.querySelectorAll('[data-vibe-id]').forEach(cb => { cb.checked = on; });
      updateVibeCount();
    }

    function getVibeSelection() {
      return Array.from(vibeSelection).sort((a, b) => a - b);
    }

    async function playVibeWithSelection() {
      const clusterIds = getVibeSelection();
      if (!clusterIds.length) { alert('Pick at least one cluster'); return; }
      await fetch('/api/play-vibe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clusterIds }),
      });
      location.reload();
    }

    async function saveVibeSelection() {
      const clusterIds = getVibeSelection();
      if (!clusterIds.length) { alert('Pick at least one cluster'); return; }
      const status = document.getElementById('vibe-save-status');
      status.innerText = 'Saving...';
      const res = await fetch('/api/play-vibe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clusterIds, saveOnly: true }),
      });
      const data = await res.json();
      status.innerText = data.success ? 'Saved ' + data.clusterIds.length + ' picks to DB.' : 'Save failed: ' + (data.error || 'unknown');
    }

    async function playScheduledVibe() {
      await fetch('/api/play-vibe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useSchedule: true }),
      });
      location.reload();
    }

    function loadActiveSlot() {
      if (!activeSchedule) { alert('No schedule slot matches the current hour'); return; }
      renderVibePicker(activeSchedule.clusterIds);
    }

    function renderActiveSlot() {
      const el = document.getElementById('active-slot');
      if (!el) return;
      el.innerText = activeSchedule
        ? 'Current slot: ' + activeSchedule.name + ' (' + activeSchedule.startHour + '-' + activeSchedule.endHour + 'h): ' + activeSchedule.clusterIds.map(clusterLabel).join(', ')
        : 'No schedule slot matches the current hour — manual picks apply.';
    }

    function renderSchedules() {
      const el = document.getElementById('schedule-list');
      if (!vibeSchedules.length) { el.innerHTML = '<p style="color:#999">No slots yet.</p>'; return; }
      el.innerHTML = '<table style="width:100%; font-size: 13px; border-collapse: collapse;">' +
        '<tr style="text-align:left; color:#666;"><th>Name</th><th>Hours</th><th>Clusters</th><th>On</th><th></th></tr>' +
        vibeSchedules.map(s => {
          const isActive = activeSchedule && s.id === activeSchedule.id;
          return '<tr style="border-top: 1px solid #eee; ' + (isActive ? 'background:#f0fff4;' : '') + '">' +
            '<td><b>' + s.name + '</b>' + (isActive ? ' <span style="color:#28a745; font-size:11px;">● now</span>' : '') + '</td>' +
            '<td>' + s.startHour + '-' + s.endHour + 'h</td>' +
            '<td>' + s.clusterIds.map(clusterLabel).join(', ') + '</td>' +
            '<td><input type="checkbox" ' + (s.enabled !== false ? 'checked' : '') + ' onchange="toggleSchedule(' + s.id + ', this.checked)" /></td>' +
            '<td style="white-space: nowrap;">' +
              '<button onclick="applySchedule(' + s.id + ')" style="padding: 4px 10px; background:#6c757d;">Load</button> ' +
              '<button onclick="removeSchedule(' + s.id + ')" style="padding: 4px 10px;" class="danger">Del</button>' +
            '</td></tr>';
        }).join('') + '</table>';
    }

    async function refreshSchedules() {
      const res = await fetch('/api/vibe-schedules');
      const data = await res.json();
      if (data.success) {
        vibeSchedules = data.schedules;
        activeSchedule = data.activeSchedule;
        renderSchedules();
        renderActiveSlot();
      }
    }

    async function createSchedule() {
      const name = document.getElementById('schedName').value;
      const startHour = parseInt(document.getElementById('schedStart').value);
      const endHour = parseInt(document.getElementById('schedEnd').value);
      const raw = document.getElementById('schedClusters').value.trim();
      const clusterIds = raw ? raw.split(',').map(x => parseInt(x.trim())).filter(x => Number.isInteger(x)) : getVibeSelection();
      const res = await fetch('/api/vibe-schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, startHour, endHour, clusterIds }),
      });
      const data = await res.json();
      if (!data.success) { alert('Failed: ' + data.error); return; }
      document.getElementById('schedName').value = '';
      document.getElementById('schedClusters').value = '';
      await refreshSchedules();
    }

    async function toggleSchedule(id, enabled) {
      await fetch('/api/vibe-schedules', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, enabled }),
      });
      await refreshSchedules();
    }

    function applySchedule(id) {
      const s = vibeSchedules.find(x => x.id === id);
      if (s) renderVibePicker(s.clusterIds);
    }

    async function removeSchedule(id) {
      if (!confirm('Delete this slot?')) return;
      await fetch('/api/vibe-schedules?id=' + id, { method: 'DELETE' });
      await refreshSchedules();
    }

    // Load saved vibe selection, fallback to all CLUSTER_NAMES keys checked per server defaults
    fetch('/api/play-vibe')
      .then(res => res.json())
      .then(data => {
        if (data.success && Array.isArray(data.clusterIds)) renderVibePicker(data.clusterIds);
        else renderVibePicker([]);
        if (data.success) {
          vibeSchedules = data.schedules || [];
          activeSchedule = data.activeSchedule || null;
          renderSchedules();
          renderActiveSlot();
        }
      })
      .catch(() => renderVibePicker([]));

    // Load Clusters on Page Load
    fetch('/api/clusters')
      .then(res => res.json())
      .then(data => {
        const grid = document.getElementById('cluster-grid');
        grid.innerHTML = data.map(c => {
          const isActive = CURRENT_FAMILY.includes(c.clusterId);
          return \`
            <div class="cluster-card \${isActive ? 'active-family' : ''}" onclick="getRecommendations(\${c.clusterId}, '\${CLUSTER_NAMES[c.clusterId] || 'Cluster ' + c.clusterId}')">
              <span class="cluster-id">#\${c.clusterId}</span>
              <span class="cluster-name">\${CLUSTER_NAMES[c.clusterId] || 'Unknown Vibe'}</span>
              <div class="cluster-preview">
                \${c.name}
                <br> <i>\${c.artists.join(', ')}</i>
              </div>
            </div>
          \`;
        }).join('');

      });

    async function getRecommendations(id, label) {
      const limit = parseInt(document.getElementById('recommendLimit').value) || 30;
      const seedSearch = document.getElementById('seedSearch')?.value;

      const resultsDiv = document.getElementById('recommendation-results');
      const recDiv = document.getElementById('recommendations');
      const title = document.getElementById('results-title');
      
      resultsDiv.style.display = 'block';
      title.innerText = 'Recommendations: ' + (label || seedSearch || 'Cluster ' + id);
      recDiv.innerHTML = '<p>Generating playlist...</p>';
      resultsDiv.scrollIntoView({ behavior: 'smooth' });

      try {
        let response;
        if (id !== undefined) {
          response = await fetch('/api/sample-cluster?clusterId=' + id, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
          });
        } else if (seedSearch) {
          // Search for track first
          const searchRes = await fetch('/api/search?q=' + encodeURIComponent(seedSearch));
          const searchData = await searchRes.json();
          
          if (searchData.success && searchData.tracks.length > 0) {
            const seedUri = searchData.tracks[0].uri;
            const seedName = searchData.tracks[0].name;
            title.innerText = 'Recommendations for: ' + seedName;
            
            response = await fetch('/api/recommend', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ seedUris: [seedUri], limit }),
            });
          } else {
            recDiv.innerHTML = '<p>No track found matching "' + seedSearch + '"</p>';
            return;
          }
        } else {
          recDiv.innerHTML = '<p>Please enter a track name or select a cluster.</p>';
          return;
        }

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

    async function addArtistToLidarrFromDebug() {
      const artistInput = document.getElementById('artistName');
      const resultsDiv = document.getElementById('lidarr-results');
      const artistName = artistInput?.value?.trim();

      if (!artistName) {
        resultsDiv.innerHTML = '<p style="color:#dc3545">Please enter an artist name.</p>';
        return;
      }

      resultsDiv.innerHTML = '<p>Adding artist to Lidarr...</p>';

      try {
        const response = await fetch('/api/lidarr/add-artist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: artistName }),
        });
        const data = await response.json();

        if (data.success) {
          resultsDiv.innerHTML = '<p style="color:#28a745">' + data.message + '</p>';
        } else {
          resultsDiv.innerHTML = '<p style="color:#dc3545">' + (data.message || 'Failed to add artist') + '</p>';
        }
      } catch (err) {
        resultsDiv.innerHTML = '<p style="color:#dc3545">Error: ' + err.message + '</p>';
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


// Check environment variable
const wledIp = env.WLED_IP;
if (!wledIp) {
  console.warn("WLED_IP environment variable is not set; WLED visualization disabled.");
} else {
  console.log(`Using WLED IP: ${wledIp}`);

  // Wait a bit then start continuous visualization
  await startWLEDVisualization(wledIp);
}
