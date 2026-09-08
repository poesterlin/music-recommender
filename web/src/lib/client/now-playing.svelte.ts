/**
 * Shared live now-playing state.
 *
 * The booth Player polls /api/player every few seconds; the header shows
 * the same store instead of its own SSR snapshot. Like/Skip then act on
 * the track that's actually displayed (explicit uri), so the action can
 * never drift onto the wrong song.
 */

export type LiveTrack = {
	uri: string;
	name: string;
	artists: string[];
};

class NowPlayingStore {
	track = $state<LiveTrack | null>(null);

	/** Seed from a server load (getCurrentTrack shape). */
	seed(server: { uri: string; name: string; artists: string[] } | null) {
		this.track = server
			? { uri: server.uri, name: server.name, artists: [...server.artists] }
			: null;
	}

	/** Update from a /api/player response (PlayerState shape). */
	setPlayer(json: { track?: { uri: string; title: string; artist: string } | null } | null) {
		if (!json?.track?.uri) {
			this.track = null;
			return;
		}
		const t = json.track;
		this.track = {
			uri: t.uri,
			name: t.title,
			artists: t.artist ? [t.artist] : []
		};
	}

	async refresh() {
		try {
			const res = await fetch('/api/player');
			if (!res.ok) return;
			const json = await res.json();
			if (json?.success === false) return;
			this.setPlayer(json);
		} catch {
			// keep last known track on poll failure
		}
	}
}

export const nowPlayingStore = new NowPlayingStore();
