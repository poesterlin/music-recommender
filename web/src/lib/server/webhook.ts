import { eq } from 'drizzle-orm';
import { db } from './db';
import { trackTable } from './schema';
import { withMa } from './ma-client';
import { preferredPlayerName } from './player';

const QUEUE_ERROR_LOG_INTERVAL_MS = 60_000;
let lastQueueErrorLogAt = 0;
let suppressedQueueErrorCount = 0;

function logQueueError(message: string, details?: string) {
	const now = Date.now();
	const shouldLogNow = now - lastQueueErrorLogAt >= QUEUE_ERROR_LOG_INTERVAL_MS;

	if (!shouldLogNow) {
		suppressedQueueErrorCount += 1;
		return;
	}

	if (suppressedQueueErrorCount > 0) {
		console.warn(`Suppressed ${suppressedQueueErrorCount} repeated queue errors`);
		suppressedQueueErrorCount = 0;
	}

	console.error(message);
	if (details) {
		console.error(details);
	}
	lastQueueErrorLogAt = now;
}

export async function playSongs(ids: string[], playerId?: string) {
	// Direct Music Assistant playback over the native WebSocket API.
	const { playUris } = await import('./player');
	await playUris(ids, { playerId });
	console.log(`Playing ${ids.length} songs via Music Assistant`);
}

export type CurrentTrack = {
	uri: string;
	name: string;
	album: string;
	artists: string[];
	clusterId?: number | null;
	speaker?: string;
};

async function enrichWithCluster(track: Omit<CurrentTrack, 'clusterId'>): Promise<CurrentTrack> {
	const [dbTrack] = await db.select().from(trackTable).where(eq(trackTable.uri, track.uri));

	if (dbTrack) {
		return {
			uri: dbTrack.uri,
			name: dbTrack.name,
			album: dbTrack.album,
			artists: dbTrack.artist,
			clusterId: dbTrack.clusterId,
			speaker: track.speaker
		};
	}
	return track;
}

/** Now-playing straight from Music Assistant (players/all -> current_media). */
async function getCurrentTrackFromMA(): Promise<CurrentTrack | null> {
	const preferred = await preferredPlayerName();
	return withMa(async (call) => {
		const players: any[] = await call('players/all');
		const withMedia = players.filter((p) => p?.current_media?.uri);
		const configured = preferred
			? withMedia.find(
					(p) =>
						String(p.name ?? '').trim() === preferred || String(p.player_id ?? '') === preferred
				)
			: null;
		if (preferred && !configured) return null;
		const pick =
			configured ??
			withMedia.find((p) => p.state === 'playing') ??
			withMedia.find((p) => p.state === 'paused') ??
			withMedia[0];
		if (!pick) return null;
		const cm = pick.current_media;
		if (cm.media_type && cm.media_type !== 'track') return null;
		return enrichWithCluster({
			uri: String(cm.uri),
			name: String(cm.title ?? 'Unknown'),
			album: String(cm.album ?? ''),
			artists: typeof cm.artist === 'string' && cm.artist ? [cm.artist] : [],
			speaker: String(pick.name ?? pick.player_id)
		});
	});
}

export async function getCurrentTrack(): Promise<CurrentTrack | null> {
	try {
		return await getCurrentTrackFromMA();
	} catch (e) {
		logQueueError('Now-playing lookup failed: ' + String(e));
		return null;
	}
}
