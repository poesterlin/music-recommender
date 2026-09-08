<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { post } from '$lib/api';
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

	let { initial }: { initial: State | null } = $props();

	let player = $state<State | null>(initial);
	let busy = $state<string | null>(null);
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
		}
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

<section class="relative overflow-hidden rounded-3xl bg-ink p-6 text-cream shadow-xl sm:p-7">
	<div class="pointer-events-none absolute -top-24 -right-24 size-64 rounded-full bg-accent/25 blur-3xl"></div>
	<div class="pointer-events-none absolute -bottom-28 -left-16 size-64 rounded-full bg-gold/15 blur-3xl"></div>

	<div class="relative">
		<h2 class="flex items-center gap-2 text-[11px] font-bold tracking-[0.28em] text-cream/60 uppercase">
			<span class="relative flex size-2">
				{#if playing}
					<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-70"></span>
				{/if}
				<span class="relative inline-flex size-2 rounded-full {playing ? 'bg-accent' : 'bg-cream/40'}"></span>
			</span>
			Now spinning{#if player} <span class="normal-case">· {player.playerName}</span>{/if}
		</h2>

		{#if player?.track}
			<div class="mt-4 flex items-center gap-5">
				{#if player.track.image}
					<img
						src={player.track.image}
						alt={player.track.album}
						class="h-24 w-24 shrink-0 rounded-2xl object-cover shadow-lg ring-1 ring-cream/20"
						loading="lazy"
					/>
				{:else}
					<div class="vinyl h-24 w-24 shrink-0 rounded-full shadow-lg ring-1 ring-cream/20 {playing ? 'animate-spin-slow' : ''}">
						<div class="flex h-full w-full items-center justify-center">
							<div class="vinyl-label flex size-8 items-center justify-center rounded-full">
								<div class="size-2 rounded-full bg-ink"></div>
							</div>
						</div>
					</div>
				{/if}
				<div class="min-w-0">
					<p class="truncate font-display text-2xl leading-tight font-black sm:text-3xl">{player.track.title}</p>
					<p class="truncate font-bold text-cream/80">{player.track.artist}</p>
					<p class="truncate text-sm text-cream/50 italic">{player.track.album}</p>
				</div>
			</div>

			<!-- progress (click to seek) -->
			<div class="mt-5">
				<button class="block h-4 w-full cursor-pointer" onclick={seek} title="Seek" aria-label="Seek in track">
					<span class="block h-1.5 overflow-hidden rounded-full bg-cream/15">
						<span
							class="block h-full rounded-full bg-accent transition-all"
							style="width: {duration ? Math.min(100, (elapsed / duration) * 100) : 0}%"
						></span>
					</span>
				</button>
				<div class="mt-1.5 flex justify-between text-xs font-bold text-cream/50 tabular-nums">
					<span>{fmt(elapsed)}</span>
					<span>{fmt(duration)}</span>
				</div>
			</div>

			<!-- transport -->
			<div class="mt-4 flex flex-wrap items-center gap-2">
				<button
					class="rounded-full bg-cream/10 px-4 py-2.5 font-bold text-cream transition hover:bg-cream/20 disabled:opacity-40"
					disabled={busy !== null}
					onclick={() => action('previous')}
					title="Previous track"
				>
					⏮
				</button>
				<button
					class="rounded-full bg-accent px-7 py-2.5 font-bold text-cream shadow-lg shadow-accent/30 transition hover:bg-accent-deep disabled:opacity-40"
					disabled={busy !== null}
					onclick={() => action(playing ? 'pause' : 'play')}
					title={playing ? 'Pause' : 'Play'}
				>
					{busy ? '…' : playing ? '⏸ Pause' : '▶ Play'}
				</button>
				<button
					class="rounded-full bg-cream/10 px-4 py-2.5 font-bold text-cream transition hover:bg-cream/20 disabled:opacity-40"
					disabled={busy !== null}
					onclick={() => action('next')}
					title="Next track"
				>
					⏭
				</button>
				<button
					class="rounded-full bg-cream/10 px-4 py-2.5 font-bold text-cream transition hover:bg-cream/20 disabled:opacity-40"
					disabled={busy !== null}
					onclick={() => action('stop')}
					title="Stop"
				>
					⏹
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
					<label class="ml-auto flex items-center gap-2 text-sm font-bold text-cream/60">
						<button class="transition hover:text-cream" onclick={toggleMute} title={volume > 0 ? 'Mute' : 'Unmute'}>
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
				<div class="vinyl h-24 w-24 shrink-0 rounded-full opacity-60 ring-1 ring-cream/20">
					<div class="flex h-full w-full items-center justify-center">
						<div class="vinyl-label flex size-8 items-center justify-center rounded-full">
							<div class="size-2 rounded-full bg-ink"></div>
						</div>
					</div>
				</div>
				<div>
					<p class="font-display text-2xl font-black">The deck is quiet.</p>
					<p class="mt-1 text-sm text-cream/60">Drop a vibe below and the room wakes up.</p>
				</div>
			</div>
		{/if}
	</div>
</section>
