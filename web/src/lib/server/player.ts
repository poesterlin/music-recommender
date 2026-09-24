/**
 * Native Music Assistant player backend.
 * Read + control playback directly over the MA WebSocket API —
 * no Home Assistant proxy involved.
 *
 * Required env: MUSIC_HOST (https base URL), MA_TOKEN.
 * Optional: MA_PLAYER_NAME selects the main player. When it is unset, queue
 * views include every Music Assistant player.
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

export function preferredPlayerName(): string | null {
	const configured = process.env.MA_PLAYER_NAME?.trim();
	return configured || null;
}

function isConfiguredPlayer(player: any, preferred: string): boolean {
	return (
		String(player?.name ?? '').trim() === preferred || String(player?.player_id ?? '') === preferred
	);
}

/** Use the configured player exactly; otherwise follow active playback. */
function pickPlayer(players: any[], preferred: string | null): any | null {
	if (preferred) {
		const configured = players.find((player) => isConfiguredPlayer(player, preferred));
		if (!configured) throw new Error(`Configured MA player "${preferred}" was not found`);
		return configured;
	}

	const withMedia = players.filter((player) => player?.current_media?.uri);
	if (!withMedia.length) {
		// Nothing playing anywhere — still return an idle player so controls
		// (volume, play) have a target.
		return players.find((player) => player?.player_id) ?? null;
	}
	return (
		withMedia.find((player) => player.state === 'playing') ??
		withMedia.find((player) => player.state === 'paused') ??
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

type QueueTarget = { player: any; queueId: string };

/** Resolve one player's active queue id. */
async function resolvePlayerTarget(
	call: (command: string, args?: Record<string, unknown>) => Promise<any>,
	player: any
): Promise<QueueTarget> {
	// Grouped players report active_source as the syncgroup queue id.
	let queueId: string = String(player.active_source ?? player.player_id);
	try {
		const active = await call('player_queues/get_active_queue', { player_id: player.player_id });
		if (active?.queue_id) queueId = String(active.queue_id);
	} catch {
		// Fall back to active_source / player_id.
	}
	return { player, queueId };
}

/** Resolve the player used by playback controls and now-playing. */
async function resolveTarget(
	call: (command: string, args?: Record<string, unknown>) => Promise<any>
): Promise<QueueTarget> {
	const preferred = preferredPlayerName();
	const players: any[] = await call('players/all');
	const player = pickPlayer(players, preferred);
	if (!player) throw new Error('No MA players found');
	return resolvePlayerTarget(call, player);
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
	| 'previous'
	| 'clear';

export type UpNextTrack = {
	uri: string | null;
	name: string;
	artists: string[];
	album: string;
	duration: number | null;
	queueItemId: string | null;
};

export type PlayerQueue = {
	queueId: string;
	playerIds: string[];
	playerNames: string[];
	state: string;
	currentIndex: number;
	currentTrack: UpNextTrack | null;
	tracks: UpNextTrack[];
	hasMore: boolean;
};

export type QueueSnapshot = {
	scope: 'main' | 'all';
	mainPlayer: string | null;
	queues: PlayerQueue[];
};

type MaCall = (command: string, args?: Record<string, unknown>) => Promise<any>;

function toQueueTrack(item: any): UpNextTrack {
	const media = item?.media_item ?? {};
	const artists: string[] = Array.isArray(media.artists)
		? media.artists.map((artist: any) => String(artist?.name ?? artist ?? '')).filter(Boolean)
		: typeof media.artist === 'string' && media.artist
			? [media.artist]
			: [];
	return {
		uri: typeof media.uri === 'string' ? media.uri : null,
		queueItemId: item?.queue_item_id != null ? String(item.queue_item_id) : null,
		name: String(media.name ?? item?.name ?? 'Unknown'),
		artists,
		album: typeof media.album === 'string' ? media.album : String(media.album?.name ?? ''),
		duration:
			typeof item?.duration === 'number'
				? item.duration
				: typeof media.duration === 'number'
					? media.duration
					: null
	};
}

type QueueGroupTarget = QueueTarget & { players: any[] };

async function loadPlayerQueue(
	call: MaCall,
	target: QueueGroupTarget,
	limit: number
): Promise<PlayerQueue> {
	const queue: any = await call('player_queues/get', { queue_id: target.queueId }).catch(
		() => null
	);
	const currentIndex: number = typeof queue?.current_index === 'number' ? queue.current_index : -1;
	const itemOffset = Math.max(0, currentIndex);
	const result: any = await call('player_queues/items', {
		queue_id: target.queueId,
		limit: limit + (currentIndex >= 0 ? 2 : 1),
		offset: itemOffset
	}).catch(() => []);
	const items: any[] = Array.isArray(result) ? result : [];
	const currentItem = currentIndex >= 0 ? items[0] : null;
	const upcomingItems = currentIndex >= 0 ? items.slice(1) : items;
	const currentTrack = currentItem
		? toQueueTrack(currentItem)
		: target.player?.current_media?.uri
			? toQueueTrack({ media_item: target.player.current_media })
			: null;
	const tracks = upcomingItems.slice(0, limit).map(toQueueTrack);

	return {
		queueId: target.queueId,
		playerIds: target.players.map((player) => String(player.player_id)),
		playerNames: target.players.map((player) => String(player.name ?? player.player_id)),
		state: String(queue?.state ?? target.player.state ?? 'idle'),
		currentIndex,
		currentTrack,
		tracks,
		hasMore: upcomingItems.length > limit
	};
}

/** Live queues for the configured main player, or every player when unset. */
export async function getQueues(limit = 30): Promise<QueueSnapshot> {
	const itemLimit = Math.max(1, Math.min(100, Math.round(limit)));
	const mainPlayer = preferredPlayerName();

	return withMa(async (call) => {
		const players: any[] = await call('players/all');
		let targets: QueueTarget[];

		if (mainPlayer) {
			const player = pickPlayer(players, mainPlayer);
			if (!player) throw new Error('No MA players found');
			targets = [await resolvePlayerTarget(call, player)];
		} else {
			const available = players.filter((player) => player?.player_id);
			targets = await Promise.all(available.map((player) => resolvePlayerTarget(call, player)));
		}

		// Sync groups can expose the same queue through several players. Keep
		// the queue once, while retaining every device name for the UI.
		const grouped = new Map<string, QueueGroupTarget>();
		for (const target of targets) {
			const existing = grouped.get(target.queueId);
			if (existing) existing.players.push(target.player);
			else grouped.set(target.queueId, { ...target, players: [target.player] });
		}

		const queues = await Promise.all(
			[...grouped.values()].map((target) => loadPlayerQueue(call, target, itemLimit))
		);
		const stateOrder: Record<string, number> = { playing: 0, paused: 1, buffering: 2 };
		queues.sort(
			(a, b) =>
				(stateOrder[a.state] ?? 3) - (stateOrder[b.state] ?? 3) ||
				a.playerNames.join(', ').localeCompare(b.playerNames.join(', '))
		);

		return { scope: mainPlayer ? 'main' : 'all', mainPlayer, queues };
	});
}

export async function seekTo(positionSeconds: number): Promise<void> {
	return withMa(async (call) => {
		const { player } = await resolveTarget(call);
		await call('players/cmd/seek', {
			player_id: player.player_id,
			position: Math.max(0, Math.round(positionSeconds))
		});
	});
}

export async function setShuffle(enabled: boolean): Promise<void> {
	return withMa(async (call) => {
		const { queueId } = await resolveTarget(call);
		await call('player_queues/shuffle', { queue_id: queueId, shuffle_enabled: enabled });
	});
}

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

/** Start an existing queue occurrence without replacing the queue. */
export async function playQueueItem(queueId: string, queueItemId: string): Promise<void> {
	return withMa(async (call) => {
		await call('player_queues/play_index', {
			queue_id: queueId,
			index: queueItemId
		});
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
