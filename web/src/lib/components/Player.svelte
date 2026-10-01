<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import { post } from '$lib/api';
	import { likeTrack } from '$lib/client/like-track';
	import { nowPlayingStore } from '$lib/client/now-playing.svelte';
	import { fade } from 'svelte/transition';
	import {
		IconPlayerSkipBackFilled,
		IconPlayerSkipForwardFilled,
		IconPlayerPlayFilled,
		IconPlayerPauseFilled,
		IconPlayerStop,
		IconVolume,
		IconVolumeOff,
		IconLoader2,
		IconHeart,
		IconMusic
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
	const image = $derived(player?.track?.image ?? null);

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

<section
	class="bg-ink text-cream ring-ink/20 shadow-ink/30 relative isolate overflow-hidden rounded-[2rem] shadow-2xl ring-1"
	aria-label="Now playing"
>
	<!-- The cover, blown up and blurred, becomes the room's lighting. -->
	{#key image}
		<div class="pointer-events-none absolute inset-0 -z-10" in:fade={{ duration: 700 }}>
			{#if image}
				<img
					src={image}
					alt=""
					aria-hidden="true"
					class="size-full scale-150 object-cover opacity-50 blur-3xl saturate-150"
				/>
			{:else}
				<div class="bg-accent/30 absolute -top-24 -right-24 size-96 rounded-full blur-3xl"></div>
				<div class="bg-gold/20 absolute -bottom-32 -left-16 size-96 rounded-full blur-3xl"></div>
			{/if}
		</div>
	{/key}
	<div class="from-ink/20 via-ink/55 to-ink/90 absolute inset-0 -z-10 bg-linear-to-br"></div>

	<div class="p-6 sm:p-10 lg:p-14">
		<p
			class="text-cream/70 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs font-bold tracking-[0.28em] uppercase lg:justify-start"
		>
			<span class="relative flex size-2">
				{#if playing}
					<span
						class="bg-accent absolute inline-flex h-full w-full animate-ping rounded-full opacity-70 motion-reduce:animate-none"
					></span>
				{/if}
				<span
					class="relative inline-flex size-2 rounded-full {playing ? 'bg-accent' : 'bg-cream/40'}"
				></span>
			</span>
			{playing
				? 'Now playing'
				: player?.state === 'paused'
					? 'Paused'
					: player?.state === 'buffering'
						? 'Buffering'
						: player
							? 'Player idle'
							: 'Player unavailable'}
			{#if player}<span class="text-cream/45 normal-case">· {player.playerName}</span>{/if}
		</p>

		<div class="mt-8 grid items-center gap-10 lg:grid-cols-[auto_1fr] lg:gap-16">
			<!-- Sleeve and record. The record slides out of the sleeve when it plays. -->
			<div class="flex justify-center lg:justify-start">
				<div class="relative mr-16 size-52 sm:mr-24 sm:size-72 lg:size-80">
					<div
						class="absolute inset-0 transition-transform duration-1000 ease-out motion-reduce:transition-none {playing
							? 'translate-x-[30%]'
							: 'translate-x-[7%]'}"
					>
						<div
							class="vinyl animate-vinyl-idle size-full rounded-full shadow-2xl ring-1 ring-black/60 motion-reduce:animate-none"
							style="animation-play-state: {playing ? 'running' : 'paused'}"
						>
							<div class="flex size-full items-center justify-center">
								{#if image}
									<img
										src={image}
										alt=""
										class="size-[34%] rounded-full object-cover ring-4 ring-black/70"
									/>
								{:else}
									<div class="vinyl-label size-[34%] rounded-full ring-4 ring-black/70"></div>
								{/if}
							</div>
						</div>
						<div
							class="pointer-events-none absolute inset-0 rounded-full bg-[conic-gradient(from_20deg,transparent_0_18%,rgba(255,255,255,0.1)_24%,transparent_30%_68%,rgba(255,255,255,0.1)_74%,transparent_80%)]"
						></div>
					</div>

					{#key image}
						<div class="absolute inset-0 z-10" in:fade={{ duration: 500 }}>
							{#if image}
								<img
									src={image}
									alt={player?.track?.album ?? ''}
									class="ring-cream/15 size-full rounded-lg object-cover shadow-[0_32px_60px_-18px_rgba(0,0,0,0.85)] ring-1"
								/>
							{:else if player?.track}
								<div
									class="from-accent to-gold text-cream/80 flex size-full items-center justify-center rounded-lg bg-linear-to-br shadow-2xl"
								>
									<IconMusic size={72} stroke={1.25} aria-hidden="true" />
								</div>
							{:else}
								<div
									class="border-cream/25 bg-cream/5 text-cream/40 flex size-full items-center justify-center rounded-lg border border-dashed backdrop-blur-sm"
								>
									<IconMusic size={64} stroke={1.25} aria-hidden="true" />
								</div>
							{/if}
						</div>
					{/key}
				</div>
			</div>

			{#if player?.track}
				<div class="min-w-0 text-center lg:text-left">
					<h2
						class="font-display line-clamp-3 text-4xl leading-[1.02] font-black text-balance sm:text-5xl lg:text-6xl"
					>
						{player.track.title}
					</h2>
					<p class="text-cream/90 mt-4 truncate text-xl font-bold">{player.track.artist}</p>
					<p class="text-cream/50 mt-1 truncate italic">{player.track.album}</p>

					<!-- progress (click to seek) -->
					<div class="mt-8">
						<button
							class="group block h-5 w-full cursor-pointer"
							onclick={seek}
							title="Seek"
							aria-label="Seek in track"
						>
							<span class="bg-cream/15 relative block h-1 rounded-full">
								<span
									class="bg-cream relative block h-full rounded-full transition-all"
									style="width: {duration ? Math.min(100, (elapsed / duration) * 100) : 0}%"
								>
									<span
										class="bg-cream absolute top-1/2 -right-1.5 size-3 -translate-y-1/2 rounded-full opacity-0 shadow transition group-hover:opacity-100"
									></span>
								</span>
							</span>
						</button>
						<div class="text-cream/50 mt-1 flex justify-between text-xs font-bold tabular-nums">
							<span>{fmt(elapsed)}</span>
							<span>{fmt(duration)}</span>
						</div>
					</div>

					<!-- transport -->
					<div class="mt-5 flex items-center justify-center gap-4 lg:justify-start">
						<button
							class="text-cream/75 hover:bg-cream/10 hover:text-cream focus-visible:outline-cream flex size-12 shrink-0 items-center justify-center rounded-full transition focus-visible:outline-2 focus-visible:outline-offset-2 active:scale-95 disabled:opacity-40"
							disabled={busy !== null}
							onclick={() => action('previous')}
							title="Previous track"
							aria-label="Previous track"
						>
							<IconPlayerSkipBackFilled size={26} aria-hidden="true" />
						</button>
						<button
							class="bg-accent text-cream shadow-accent/40 hover:bg-accent-deep focus-visible:outline-cream flex size-20 shrink-0 items-center justify-center rounded-full shadow-[0_12px_40px_-8px] transition hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-4 active:scale-95 disabled:opacity-60"
							disabled={busy !== null}
							onclick={() => action(playing ? 'pause' : 'play')}
							title={playing ? 'Pause' : 'Play'}
							aria-label={playing ? 'Pause' : 'Play'}
						>
							{#if busy === 'play' || busy === 'pause'}
								<IconLoader2 size={34} class="animate-spin" aria-hidden="true" />
							{:else if playing}
								<IconPlayerPauseFilled size={34} aria-hidden="true" />
							{:else}
								<IconPlayerPlayFilled size={34} class="translate-x-0.5" aria-hidden="true" />
							{/if}
						</button>
						<button
							class="text-cream/75 hover:bg-cream/10 hover:text-cream focus-visible:outline-cream flex size-12 shrink-0 items-center justify-center rounded-full transition focus-visible:outline-2 focus-visible:outline-offset-2 active:scale-95 disabled:opacity-40"
							disabled={busy !== null}
							onclick={() => action('next')}
							title="Next track"
							aria-label="Next track"
						>
							<IconPlayerSkipForwardFilled size={26} aria-hidden="true" />
						</button>
						<button
							class="text-cream/75 hover:text-cream hover:bg-moss/60 focus-visible:outline-cream ml-2 flex size-12 shrink-0 items-center justify-center rounded-full transition focus-visible:outline-2 focus-visible:outline-offset-2 active:scale-95 disabled:cursor-wait disabled:opacity-50"
							disabled={liking}
							onclick={likeCurrentTrack}
							title="Like {player.track.title}"
							aria-label="Like {player.track.title}"
						>
							<IconHeart size={24} aria-hidden="true" />
						</button>
					</div>

					<div
						class="text-cream/60 mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm font-bold lg:justify-start"
					>
						{#if volume !== null}
							<div class="flex items-center gap-1">
								<button
									class="hover:bg-cream/10 hover:text-cream focus-visible:outline-cream flex size-10 items-center justify-center rounded-full transition focus-visible:outline-2 focus-visible:outline-offset-2"
									onclick={toggleMute}
									title={volume > 0 ? 'Mute' : 'Unmute'}
									aria-label={volume > 0 ? 'Mute' : 'Unmute'}
								>
									{#if volume > 0}<IconVolume size={20} aria-hidden="true" />{:else}<IconVolumeOff
											size={20}
											aria-hidden="true"
										/>{/if}
								</button>
								<input
									type="range"
									min="0"
									max="100"
									step="1"
									bind:value={volume}
									oninput={onVolume}
									class="w-32 accent-[#e8490f]"
									aria-label="Volume"
								/>
								<span class="w-8 text-right tabular-nums">{volume}</span>
							</div>
						{/if}
						<button
							class="hover:text-cream hover:bg-cream/10 focus-visible:outline-cream inline-flex min-h-10 items-center gap-2 rounded-full px-3 transition focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40"
							disabled={busy !== null}
							onclick={clearQueue}
						>
							{#if busy === 'clear'}
								<IconLoader2 size={18} class="animate-spin" aria-hidden="true" />
							{:else}
								<IconPlayerStop size={18} aria-hidden="true" />
							{/if}
							Stop and clear queue
						</button>
					</div>
				</div>
			{:else}
				<div class="min-w-0 text-center lg:text-left">
					<h2 class="font-display text-4xl leading-[1.05] font-black text-balance sm:text-5xl">
						{playing
							? 'Playback is active'
							: player?.state === 'buffering'
								? 'Loading audio…'
								: player
									? 'Nothing playing'
									: 'Player unavailable'}
					</h2>
					<p class="text-cream/65 mt-4 text-lg">
						{playing
							? 'Track details are not available yet.'
							: player
								? 'Pick a mix and the record starts turning.'
								: 'Check the Music Assistant connection.'}
					</p>
					{#if player && !playing}
						<a
							href="#mix"
							class="bg-cream text-ink hover:bg-accent hover:text-cream focus-visible:outline-cream mt-8 inline-flex min-h-12 items-center gap-2 rounded-full px-6 font-bold transition focus-visible:outline-2 focus-visible:outline-offset-4"
						>
							Choose what to play
						</a>
					{/if}
				</div>
			{/if}
		</div>
	</div>
</section>
