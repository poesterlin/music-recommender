/**
 * Native Music Assistant player backend.
 * Read + control playback directly over the MA WebSocket API —
 * no Home Assistant proxy involved.
 *
 * Required env: MUSIC_HOST (https base URL), MA_TOKEN.
 * Optional: MA_PLAYER_NAME (defaults to "Wohnzimmer").
 */

import { withMa } from './ma-client';

export type PlayerTrack = {
	uri: string;
	title: string;
	artist: string;
	album: string;
	duration: number | null;
	image: string | null;
};

export type PlayerState = {
	playerId: string;
	playerName: string;
	queueId: string;
	state: string; // playing | paused | idle | ...
	volumeLevel: number | null;
	muted: boolean | null;
	elapsed: number | null;
	shuffle: boolean | null;
	repeat: string | null;
	currentIndex: number | null;
	track: PlayerTrack | null;
};

export function preferredPlayerName(): string {
	return process.env.MA_PLAYER_NAME ?? 'Wohnzimmer';
}

/** Pick the most relevant player: preferred name playing/paused first. */
function pickPlayer(players: any[], preferred: string): any | null {
	const withMedia = players.filter((p) => p?.current_media?.uri);
	if (!withMedia.length) {
		// Nothing playing anywhere — still return the preferred/idle player
		// so controls (volume, play) have a target.
		return (
			players.find((p) => p.name === preferred) ??
			players.find((p) => p.player_id) ??
			null
		);
	}
	return (
		withMedia.find((p) => p.name === preferred && (p.state === 'playing' || p.state === 'paused')) ??
		withMedia.find((p) => p.state === 'playing') ??
		withMedia.find((p) => p.state === 'paused') ??
		withMedia.find((p) => p.name === preferred) ??
		withMedia[0]
	);
}

function toTrack(cm: any): PlayerTrack | null {
	if (!cm?.uri) return null;
	const images: any[] = cm?.metadata?.images ?? [];
	return {
		uri: String(cm.uri),
		title: String(cm.title ?? 'Unknown'),
		artist: typeof cm.artist === 'string' ? cm.artist : (cm.artists ?? []).map((a: any) => a.name ?? a).join(', '),
		album: typeof cm.album === 'string' ? cm.album : (cm.album?.name ?? ''),
		duration: typeof cm.duration === 'number' ? cm.duration : null,
		image: cm.image_url ?? images[0]?.url ?? null
	};
}

/** Resolve the target player and its active queue id. */
async function resolveTarget(
	call: (command: string, args?: Record<string, unknown>) => Promise<any>
): Promise<{ player: any; queueId: string }> {
	const preferred = preferredPlayerName();
	const players: any[] = await call('players/all');
	const player = pickPlayer(players, preferred);
	if (!player) throw new Error('No MA players found');

	// Grouped players report active_source as the syncgroup queue id.
	let queueId: string = player.active_source ?? player.player_id;
	try {
		const active = await call('player_queues/get_active_queue', { player_id: player.player_id });
		if (active?.queue_id) queueId = String(active.queue_id);
	} catch {
		// fall back to active_source / player_id
	}
	return { player, queueId };
}

export async function getPlayerState(): Promise<PlayerState | null> {
	return withMa(async (call) => {
		const { player, queueId } = await resolveTarget(call);
		let queue: any = null;
		try {
			queue = await call('player_queues/get', { queue_id: queueId });
		} catch {
			queue = null;
		}
		const cm = player.current_media;
		return {
			playerId: String(player.player_id),
			playerName: String(player.name ?? player.player_id),
			queueId,
			state: String(queue?.state ?? player.state ?? 'idle'),
			volumeLevel: typeof player.volume_level === 'number' ? player.volume_level : null,
			muted: typeof player.volume_muted === 'boolean' ? player.volume_muted : null,
			elapsed: typeof queue?.elapsed_time === 'number' ? queue.elapsed_time : null,
			shuffle: typeof queue?.shuffle_enabled === 'boolean' ? queue.shuffle_enabled : null,
			repeat: queue?.repeat_mode ? String(queue.repeat_mode) : null,
			currentIndex: typeof queue?.current_index === 'number' ? queue.current_index : null,
			track: toTrack(cm)
		};
	});
}

export type PlayerAction =
	| 'play'
	| 'pause'
	| 'play_pause'
	| 'stop'
	| 'next'
	| 'previous';

/** Transport control on the active queue. */
export async function playerControl(action: PlayerAction): Promise<void> {
	const cmd =
		action === 'next'
			? 'player_queues/next'
			: action === 'previous'
				? 'player_queues/previous'
				: `player_queues/${action}`;
	return withMa(async (call) => {
		const { queueId } = await resolveTarget(call);
		await call(cmd, { queue_id: queueId });
	});
}

export async function setVolume(level: number): Promise<void> {
	const clamped = Math.max(0, Math.min(100, Math.round(level)));
	return withMa(async (call) => {
		const { player } = await resolveTarget(call);
		await call('players/cmd/volume_set', {
			player_id: player.player_id,
			volume_level: clamped
		});
	});
}

/**
 * Replace the active queue with the given track URIs and start playback.
 * This is the native-MA replacement for the old HA webhook playSongs path.
 */
export async function playUris(uris: string[], opts: { shuffle?: boolean } = {}): Promise<void> {
	if (!uris.length) return;
	return withMa(async (call) => {
		const { queueId } = await resolveTarget(call);
		await call('player_queues/play_media', {
			queue_id: queueId,
			media: uris,
			option: 'replace'
		});
		if (opts.shuffle !== undefined) {
			try {
				await call('player_queues/shuffle', {
					queue_id: queueId,
					shuffle_enabled: opts.shuffle
				});
			} catch {
				// shuffle is best-effort
			}
		}
	});
}
