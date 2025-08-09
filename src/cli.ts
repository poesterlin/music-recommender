import { recommend } from "./recomendation-engine";
import { playSongs } from "./webhook";

const tracks = await recommend({
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
});

for (const r of tracks) {
    console.log(`Recommended: ${r.name} by ${r.artists.join(", ")}`);
}

playSongs(tracks.map((t) => t.uri));