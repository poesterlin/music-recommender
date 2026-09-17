/**
 * Watch a Home Assistant media_player entity and add each new
 * media_artist to Lidarr (via MusicBrainz lookup).
 *
 * Runs as a long-lived WebSocket subscriber started from hooks.server.ts.
 */
import { addArtistByNameToLidarr } from './add-artists';

const DEFAULT_ENTITY = 'media_player.sophie_s_boooombox';
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const MB_GAP_MS = 1_500;

type HaState = {
	entity_id?: string;
	state?: string;
	attributes?: Record<string, unknown>;
};

type HaMessage = {
	type: string;
	id?: number;
	success?: boolean;
	event?: {
		event_type?: string;
		data?: {
			entity_id?: string;
			new_state?: HaState | null;
			old_state?: HaState | null;
		};
	};
	result?: unknown;
};

function haWsUrl(host: string): string {
	return host.replace(/\/$/, '').replace(/^http/, 'ws') + '/api/websocket';
}

function artistFromState(state: HaState | null | undefined): string | null {
	const raw = state?.attributes?.media_artist;
	if (typeof raw !== 'string') return null;
	const name = raw.trim();
	return name.length > 0 ? name : null;
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

class HaLidarrWatcher {
	private entityId: string;
	private token: string;
	private wsUrl: string;
	private ws: WebSocket | null = null;
	private nextId = 1;
	private stopped = false;
	private reconnectAttempt = 0;
	private lastArtistKey: string | null = null;
	private seen = new Set<string>();
	private queue: string[] = [];
	private draining = false;

	constructor(host: string, token: string, entityId: string) {
		this.wsUrl = haWsUrl(host);
		this.token = token;
		this.entityId = entityId;
	}

	start() {
		this.stopped = false;
		console.log(`[ha-lidarr] watching ${this.entityId}`);
		this.connect();
	}

	stop() {
		this.stopped = true;
		this.ws?.close();
		this.ws = null;
	}

	private connect() {
		if (this.stopped) return;

		const ws = new WebSocket(this.wsUrl);
		this.ws = ws;

		ws.onopen = () => {
			// HA sends auth_required first; we wait for it.
		};

		ws.onmessage = (ev) => {
			let msg: HaMessage;
			try {
				msg = JSON.parse(String(ev.data));
			} catch {
				return;
			}
			void this.handleMessage(ws, msg);
		};

		ws.onclose = () => {
			if (this.ws === ws) this.ws = null;
			this.scheduleReconnect();
		};

		ws.onerror = () => {
			// onclose will fire after this
		};
	}

	private scheduleReconnect() {
		if (this.stopped) return;
		const delay = Math.min(
			RECONNECT_MAX_MS,
			RECONNECT_BASE_MS * 2 ** this.reconnectAttempt
		);
		this.reconnectAttempt += 1;
		console.warn(`[ha-lidarr] disconnected; reconnecting in ${delay}ms`);
		setTimeout(() => this.connect(), delay);
	}

	private send(ws: WebSocket, payload: Record<string, unknown>) {
		ws.send(JSON.stringify(payload));
	}

	private async handleMessage(ws: WebSocket, msg: HaMessage) {
		if (msg.type === 'auth_required') {
			this.send(ws, { type: 'auth', access_token: this.token });
			return;
		}

		if (msg.type === 'auth_invalid') {
			console.error('[ha-lidarr] HA auth failed — check TOKEN');
			this.stopped = true;
			ws.close();
			return;
		}

		if (msg.type === 'auth_ok') {
			this.reconnectAttempt = 0;
			const subId = this.nextId++;
			this.send(ws, {
				id: subId,
				type: 'subscribe_events',
				event_type: 'state_changed'
			});
			// Seed from current state so a track already playing gets added.
			void this.seedCurrentState();
			return;
		}

		if (msg.type === 'event' && msg.event?.event_type === 'state_changed') {
			const data = msg.event.data;
			if (data?.entity_id !== this.entityId) return;
			this.onState(data.new_state ?? null);
		}
	}

	private async seedCurrentState() {
		try {
			const host = (process.env.HA_HOST ?? '').replace(/\/$/, '');
			const res = await fetch(`${host}/api/states/${this.entityId}`, {
				headers: {
					Authorization: `Bearer ${this.token}`,
					Accept: 'application/json'
				}
			});
			if (!res.ok) {
				console.warn(`[ha-lidarr] seed fetch failed: ${res.status}`);
				return;
			}
			const state = (await res.json()) as HaState;
			this.onState(state);
		} catch (e) {
			console.warn('[ha-lidarr] seed fetch error:', e);
		}
	}

	private onState(state: HaState | null) {
		const artist = artistFromState(state);
		if (!artist) return;

		const key = artist.toLowerCase();
		if (key === this.lastArtistKey) return;
		this.lastArtistKey = key;

		if (this.seen.has(key)) {
			console.log(`[ha-lidarr] skip already handled: ${artist}`);
			return;
		}

		console.log(`[ha-lidarr] queueing artist: ${artist}`);
		this.queue.push(artist);
		void this.drain();
	}

	private async drain() {
		if (this.draining) return;
		this.draining = true;
		try {
			while (this.queue.length > 0) {
				const artist = this.queue.shift()!;
				const key = artist.toLowerCase();
				if (this.seen.has(key)) continue;

				try {
					const result = await addArtistByNameToLidarr(artist);
					if (result.success) {
						this.seen.add(key);
						console.log(
							`[ha-lidarr] ${result.alreadyExists ? 'exists' : 'added'}: ${artist}`
						);
					} else {
						console.warn(`[ha-lidarr] failed ${artist}: ${result.message}`);
						// Don't mark seen — retry next time this artist plays.
					}
				} catch (e) {
					console.error(`[ha-lidarr] error adding ${artist}:`, e);
				}

				await sleep(MB_GAP_MS);
			}
		} finally {
			this.draining = false;
		}
	}
}

let watcher: HaLidarrWatcher | null = null;

export function startHaLidarrWatch() {
	if (watcher) return;

	const host = process.env.HA_HOST?.trim();
	const token = process.env.TOKEN?.trim();
	const entityId =
		process.env.HA_LIDARR_WATCH_ENTITY?.trim() || DEFAULT_ENTITY;

	if (!host || !token) {
		console.warn('[ha-lidarr] HA_HOST/TOKEN missing; Lidarr watch disabled');
		return;
	}

	watcher = new HaLidarrWatcher(host, token, entityId);
	watcher.start();
}
