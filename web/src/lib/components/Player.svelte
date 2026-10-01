<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import { post } from '$lib/api';
	import { likeTrack } from '$lib/client/like-track';
	import { nowPlayingStore } from '$lib/client/now-playing.svelte';
	import {
		IconPlayerSkipBack, IconPlayerSkipForward, IconPlayerPlay, IconPlayerPause,
		IconPlayerStop, IconVolume, IconVolumeOff, IconLoader2
	} from '@tabler/icons-svelte';

	type Track = {
		uri: string;
		title: string;
		artist: string;
		album: string;
		duration: number | null;
		image: string | null;
	};

	type State = {
		playerId: string;
		playerName: string;
		state: string;
		volumeLevel: number | null;
		muted: boolean | null;
		elapsed: number | null;
		shuffle: boolean | null;
		track: Track | null;
	};

	let {
		initial,
		onQueueChange = null
	}: {
		initial: State | null;
		onQueueChange?: (() => void) | null;
	} = $props();

	// `initial` is the server-rendered bootstrap only; the client owns it after.
	let player = $state<State | null>(untrack(() => initial));
	let busy = $state<string | null>(null);
	let liking = $state(false);
	let volume = $state<number | null>(untrack(() => initial?.volumeLevel ?? null));
	let lastVolume = $state<number>(untrack(() => initial?.volumeLevel ?? 25));
	let tick = $state(0);

	const playing = $derived(player?.state === 'playing');
	const elapsed = $derived((player?.elapsed ?? 0) + tick);
	const duration = $derived(player?.track?.duration ?? null);

	function fmt(s: number | null): string {
		if (s === null || s === undefined || !isFinite(s)) return '--:--';
		s = Math.max(0, Math.floor(s));
		return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
	}

	async function refresh() {
		try {
			const res = await fetch('/api/player');
			if (!res.ok) return;
			const json = await res.json();
			if (json.success === false) return;
			player = json;
			nowPlayingStore.setPlayer(json);
			volume = json.volumeLevel ?? volume;
			tick = 0;
		} catch {
			// keep last known state on poll failure
		}
	}

	async function action(a: string) {
		busy = a;
		try {
			const { ok, data } = await post<State & { success: boolean }>('/api/player', { action: a });
			if (ok && data && 'state' in data) {
				player = data;
				nowPlayingStore.setPlayer(data);
				tick = 0;
			} else {
				await refresh();
			}
		} finally {
			busy = null;
			onQueueChange?.();
		}
	}

	async function likeCurrentTrack() {
		const track = player?.track;
		if (!track || liking) return;
		liking = true;
		try {
			await likeTrack(track.uri, track.title);
		} finally {
			liking = false;
		}
	}

	async function clearQueue() {
		if (!player || !confirm(`Clear the entire queue for ${player.playerName}?`)) return;
		await action('clear');
	}

	let volumeTimer: ReturnType<typeof setTimeout> | null = null;
	function onVolume() {
		if (volume === null) return;
		if (volume > 0) lastVolume = volume;
		if (volumeTimer) clearTimeout(volumeTimer);
		volumeTimer = setTimeout(async () => {
			const { ok, data } = await post<State & { success: boolean }>('/api/player', { volume });
			if (ok && data && 'volumeLevel' in data) volume = data.volumeLevel;
		}, 400);
	}

	async function toggleMute() {
		if (volume === null) return;
		const target = volume > 0 ? 0 : lastVolume;
		volume = target;
		await post('/api/player', { volume: target });
	}

	async function seek(e: MouseEvent) {
		if (!duration) return;
		const bar = e.currentTarget as HTMLElement;
		const rect = bar.getBoundingClientRect();
		const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
		const position = Math.round(ratio * duration);
		tick = position - (player?.elapsed ?? 0);
		await post('/api/player', { seek: position });
	}

	let poller: ReturnType<typeof setInterval> | null = null;
	let ticker: ReturnType<typeof setInterval> | null = null;

	onMount(() => {
		nowPlayingStore.setPlayer(initial);
		poller = setInterval(refresh, 5000);
		ticker = setInterval(() => {
			if (player?.state === 'playing') tick += 1;
			else tick = 0;
		}, 1000);
	});

	onDestroy(() => {
		if (poller) clearInterval(poller);
		if (ticker) clearInterval(ticker);
		if (volumeTimer) clearTimeout(volumeTimer);
	});
</script>

<section class="bg-ink text-cream relative overflow-hidden rounded-3xl p-6 shadow-xl sm:p-7">
	<div
		class="bg-accent/25 pointer-events-none absolute -top-24 -right-24 size-64 rounded-full blur-3xl"
	></div>
	<div
		class="bg-gold/15 pointer-events-none absolute -bottom-28 -left-16 size-64 rounded-full blur-3xl"
	></div>

	<div class="relative">
		<h2
			class="text-cream/60 flex items-center gap-2 text-[11px] font-bold tracking-[0.28em] uppercase"
		>
			<span class="relative flex size-2">
				{#if playing}
					<span
						class="bg-accent absolute inline-flex h-full w-full animate-ping rounded-full opacity-70"
					></span>
				{/if}
				<span
					class="relative inline-flex size-2 rounded-full {playing ? 'bg-accent' : 'bg-cream/40'}"
				></span>
			</span>
			{playing ? 'Now playing' : player?.state === 'paused' ? 'Paused' : player?.state === 'buffering' ? 'Buffering' : player ? 'Player idle' : 'Player unavailable'}{#if player}
				<span class="normal-case">· {player.playerName}</span>{/if}
		</h2>

		{#if player?.track}
			<div class="mt-4 flex items-center gap-5">
				{#if player.track.image}
					<img
						src={player.track.image}
						alt={player.track.album}
						class="ring-cream/20 h-24 w-24 shrink-0 rounded-2xl object-cover shadow-lg ring-1"
						loading="lazy"
					/>
				{:else}
					<div
						class="vinyl ring-cream/20 h-24 w-24 shrink-0 rounded-full shadow-lg ring-1 {playing
							? 'animate-spin-slow'
							: ''}"
					>
						<div class="flex h-full w-full items-center justify-center">
							<div class="vinyl-label flex size-8 items-center justify-center rounded-full">
								<div class="bg-ink size-2 rounded-full"></div>
							</div>
						</div>
					</div>
				{/if}
				<div class="min-w-0 flex-1">
					<p class="font-display truncate text-2xl leading-tight font-black sm:text-3xl">
						{player.track.title}
					</p>
					<p class="text-cream/80 truncate font-bold">{player.track.artist}</p>
					<p class="text-cream/50 truncate text-sm italic">{player.track.album}</p>
					<button
						class="bg-cream/10 text-cream/75 hover:bg-moss hover:text-cream mt-3 rounded-full px-3 py-1.5 text-xs font-bold transition disabled:cursor-wait disabled:opacity-50"
						disabled={liking}
						onclick={likeCurrentTrack}
						title="Like {player.track.title}"
					>
						{liking ? 'Liking…' : '♥ Like'}
					</button>
				</div>
			</div>

			<!-- progress (click to seek) -->
			<div class="mt-5">
				<button
					class="block h-4 w-full cursor-pointer"
					onclick={seek}
					title="Seek"
					aria-label="Seek in track"
				>
					<span class="bg-cream/15 block h-1.5 overflow-hidden rounded-full">
						<span
							class="bg-accent block h-full rounded-full transition-all"
							style="width: {duration ? Math.min(100, (elapsed / duration) * 100) : 0}%"
						></span>
					</span>
				</button>
				<div class="text-cream/50 mt-1.5 flex justify-between text-xs font-bold tabular-nums">
					<span>{fmt(elapsed)}</span>
					<span>{fmt(duration)}</span>
				</div>
			</div>

			<!-- transport -->
			<div class="mt-5 flex flex-wrap items-center gap-2 rounded-2xl border border-cream/10 bg-black/15 p-2.5">
				<button
					class="flex size-11 shrink-0 items-center justify-center rounded-xl border border-cream/10 bg-cream/5 text-cream/80 transition hover:border-cream/25 hover:bg-cream/15 hover:text-cream active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream disabled:opacity-40"
					disabled={busy !== null}
					onclick={() => action('previous')}
					title="Previous track"
					aria-label="Previous track"
				>
					<IconPlayerSkipBack size={20} aria-hidden="true" />
				</button>
				<button
					class="flex h-12 min-w-28 items-center justify-center gap-2 rounded-xl bg-accent px-5 font-bold text-cream shadow-lg shadow-accent/20 transition hover:bg-accent-deep active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream disabled:opacity-40"
					disabled={busy !== null}
					onclick={() => action(playing ? 'pause' : 'play')}
					title={playing ? 'Pause' : 'Play'}
				>
					{#if busy === 'play' || busy === 'pause'}
						<IconLoader2 size={20} class="animate-spin" aria-hidden="true" />
					{:else if playing}
						<IconPlayerPause size={20} aria-hidden="true" />
					{:else}
						<IconPlayerPlay size={20} aria-hidden="true" />
					{/if}
					{playing ? 'Pause' : 'Play'}
				</button>
				<button
					class="flex size-11 shrink-0 items-center justify-center rounded-xl border border-cream/10 bg-cream/5 text-cream/80 transition hover:border-cream/25 hover:bg-cream/15 hover:text-cream active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream disabled:opacity-40"
					disabled={busy !== null}
					onclick={() => action('next')}
					title="Next track"
					aria-label="Next track"
				>
					<IconPlayerSkipForward size={20} aria-hidden="true" />
				</button>
				<button
					class="flex size-11 shrink-0 items-center justify-center rounded-xl border border-cream/10 bg-cream/5 text-cream/65 transition hover:border-accent/50 hover:bg-accent/15 hover:text-cream active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream disabled:opacity-40"
					disabled={busy !== null}
					onclick={clearQueue}
					title="Stop and clear queue"
					aria-label="Stop and clear queue"
				>
					{#if busy === 'clear'}
						<IconLoader2 size={20} class="animate-spin" aria-hidden="true" />
					{:else}
						<IconPlayerStop size={20} aria-hidden="true" />
					{/if}
				</button>

				{#if volume !== null}
					<label class="text-cream/60 ml-auto flex items-center gap-2 text-sm font-bold">
						<button
							class="flex size-11 items-center justify-center rounded-xl transition hover:bg-cream/10 hover:text-cream focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream"
							onclick={toggleMute}
							title={volume > 0 ? 'Mute' : 'Unmute'}
							aria-label={volume > 0 ? 'Mute' : 'Unmute'}
						>
							{#if volume > 0}<IconVolume size={20} aria-hidden="true" />{:else}<IconVolumeOff size={20} aria-hidden="true" />{/if}
						</button>
						<input
							type="range"
							min="0"
							max="100"
							step="1"
							bind:value={volume}
							oninput={onVolume}
							class="w-28 accent-[#e8490f]"
							aria-label="Volume"
						/>
						<span class="w-8 text-right tabular-nums">{volume}</span>
					</label>
				{/if}
			</div>
		{:else}
			<div class="mt-4 flex items-center gap-5">
				<div class="vinyl ring-cream/20 h-24 w-24 shrink-0 rounded-full opacity-60 ring-1">
					<div class="flex h-full w-full items-center justify-center">
						<div class="vinyl-label flex size-8 items-center justify-center rounded-full">
							<div class="bg-ink size-2 rounded-full"></div>
						</div>
					</div>
				</div>
				<div>
					<p class="font-display text-2xl font-black">{playing ? 'Playback is active' : player?.state === 'buffering' ? 'Loading audio…' : player ? 'Nothing playing' : 'Player unavailable'}</p>
					<p class="text-cream/60 mt-1 text-sm">{playing ? 'Track details are not available yet.' : player ? 'Choose a vibe above to start listening.' : 'Check the Music Assistant connection.'}</p>
				</div>
			</div>
		{/if}
	</div>
</section>
