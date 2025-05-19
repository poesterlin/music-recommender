import { findSimilarTracks, getRandomTrack } from "./similar-track";
import { playSongs } from "./webhook";

// get uri from command line arguments
const args = process.argv.slice(2);
const uri = args[0] ?? await getRandomTrack();

const ids = await findSimilarTracks(uri);
await playSongs(ids);
