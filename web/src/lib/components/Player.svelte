<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { post } from '$lib/api';
	import { likeTrack } from '$lib/client/like-track';
	import { nowPlayingStore } from '$lib/client/now-playing.svelte';

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

	let player = $state<State | null>(initial);
	let busy = $state<string | null>(null);
	let liking = $state(false);
	let volume = $state<number | null>(initial?.volumeLevel ?? null);
	let lastVolume = $state<number>(initial?.volumeLevel ?? 25);
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

	async function toggleShuffle() {
		if (player?.shuffle === null || player?.shuffle === undefined) return;
		const next = !player.shuffle;
		player = { ...player, shuffle: next };
		const { ok, data } = await post<State & { success: boolean }>('/api/player', { shuffle: next });
		if (ok && data && 'shuffle' in data) player = data;
		onQueueChange?.();
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
			Now spinning{#if player}
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
			<div class="mt-4 flex flex-wrap items-center gap-2">
				<button
					class="bg-cream/10 text-cream hover:bg-cream/20 rounded-full px-4 py-2.5 font-bold transition disabled:opacity-40"
					disabled={busy !== null}
					onclick={() => action('previous')}
					title="Previous track"
				>
					⏮
				</button>
				<button
					class="bg-accent text-cream shadow-accent/30 hover:bg-accent-deep rounded-full px-7 py-2.5 font-bold shadow-lg transition disabled:opacity-40"
					disabled={busy !== null}
					onclick={() => action(playing ? 'pause' : 'play')}
					title={playing ? 'Pause' : 'Play'}
				>
					{busy ? '…' : playing ? '⏸ Pause' : '▶ Play'}
				</button>
				<button
					class="bg-cream/10 text-cream hover:bg-cream/20 rounded-full px-4 py-2.5 font-bold transition disabled:opacity-40"
					disabled={busy !== null}
					onclick={() => action('next')}
					title="Next track"
				>
					⏭
				</button>
				<button
					class="bg-cream/10 text-cream hover:bg-cream/20 rounded-full px-4 py-2.5 font-bold transition disabled:opacity-40"
					disabled={busy !== null}
					onclick={() => action('stop')}
					title="Stop"
				>
					⏹
				</button>
				<button
					class="border-cream/15 text-cream/65 hover:border-cream/35 hover:bg-cream/10 hover:text-cream rounded-full border px-4 py-2.5 font-bold transition disabled:opacity-40"
					disabled={busy !== null}
					onclick={clearQueue}
					title="Clear the entire queue"
				>
					{busy === 'clear' ? '…' : '🗑 Clear queue'}
				</button>

				{#if player.shuffle !== null && player.shuffle !== undefined}
					<button
						class="rounded-full px-4 py-2.5 font-bold transition disabled:opacity-40 {player.shuffle
							? 'bg-accent/25 text-accent'
							: 'bg-cream/10 text-cream/60 hover:bg-cream/20'}"
						disabled={busy !== null}
						onclick={toggleShuffle}
						title="Toggle shuffle"
					>
						🔀
					</button>
				{/if}

				{#if volume !== null}
					<label class="text-cream/60 ml-auto flex items-center gap-2 text-sm font-bold">
						<button
							class="hover:text-cream transition"
							onclick={toggleMute}
							title={volume > 0 ? 'Mute' : 'Unmute'}
						>
							{volume > 0 ? '🔈' : '🔇'}
						</button>
						<input
							type="range"
							min="0"
							max="100"
							step="1"
							bind:value={volume}
							oninput={onVolume}
							class="w-28 accent-[#e8490f]"
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
					<p class="font-display text-2xl font-black">The deck is quiet.</p>
					<p class="text-cream/60 mt-1 text-sm">Drop a vibe below and the room wakes up.</p>
				</div>
				{#if player}
					<button
						class="border-cream/15 text-cream/65 hover:border-cream/35 hover:bg-cream/10 hover:text-cream ml-auto rounded-full border px-4 py-2.5 text-sm font-bold transition disabled:opacity-40"
						disabled={busy !== null}
						onclick={clearQueue}
					>
						{busy === 'clear' ? 'Clearing…' : '🗑 Clear queue'}
					</button>
				{/if}
			</div>
		{/if}
	</div>
</section>
