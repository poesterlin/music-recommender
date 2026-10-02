<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import { post } from '$lib/api';
	import { likeTrack } from '$lib/client/like-track';
	import { nowPlayingStore } from '$lib/client/now-playing.svelte';
	import { toastStore } from '$lib/client/toast.svelte';
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
		IconDeviceSpeaker,
		IconHeartFilled,
		IconArrowsShuffle,
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
	let liked = $state(false);
	let likeLoaded = $state(false);
	$effect(() => {
		const uri = player?.track?.uri;
		liked = false;
		likeLoaded = false;
		let cancelled = false;
		if (uri) {
			void fetch(`/track/like?uri=${encodeURIComponent(uri)}`, { cache: 'no-store' })
				.then(async (response) => {
					if (!response.ok) return;
					const result = await response.json();
					if (!cancelled) { liked = result.liked; likeLoaded = true; }
				}).catch(() => {});
		}
		return () => { cancelled = true; };
	});
	let volume = $state<number | null>(untrack(() => initial?.volumeLevel ?? null));
	let lastVolume = $state<number>(untrack(() => initial?.volumeLevel ?? 25));
	let tick = $state(0);

	const playing = $derived(player?.state === 'playing');
	const elapsed = $derived((player?.elapsed ?? 0) + tick);
	const duration = $derived(player?.track?.duration ?? null);
	const coverSource = $derived(player?.track?.image ?? null);
	let image = $state<string | null>(null);
	$effect(() => {
		const source = coverSource;
		let cancelled = false;
		if (!source) {
			image = null;
		} else {
			const preload = new Image();
			preload.src = source;
			void preload.decode().then(() => {
				if (!cancelled) image = source;
			}).catch(() => {
				if (!cancelled) image = null;
			});
		}
		return () => { cancelled = true; };
	});

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
		if (!track || liking || !likeLoaded) return;
		liking = true;
		try {
			if (liked) {
				const response = await fetch('/track/like', {
					method: 'DELETE',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ uri: track.uri })
				});
				if (response.ok && player?.track?.uri === track.uri) liked = false;
			} else {
				const ok = await likeTrack(track.uri, track.title);
				if (ok && player?.track?.uri === track.uri) liked = true;
			}
		} finally {
			liking = false;
		}
	}

	async function toggleShuffle() {
		if (!player || busy !== null) return;
		busy = 'shuffle';
		try {
			const { ok } = await post('/api/player', { shuffle: !player.shuffle });
			if (ok) {
				await refresh();
				onQueueChange?.();
			}
		} finally {
			busy = null;
		}
	}

	async function startMix() {
		if (busy !== null) return;
		busy = 'mix';
		try {
			const { ok, data } = await post<{ error?: string }>('/api/play-vibe', {
				useSchedule: true
			});
			if (ok) {
				await refresh();
				onQueueChange?.();
			} else {
				toastStore.show(data.error ?? 'Could not start playback. Try again.');
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
			{#if player}
				<IconDeviceSpeaker size={15} class="text-cream/45" aria-hidden="true" />
				<span class="text-cream/45 normal-case">{player.playerName}</span>
			{/if}
		</p>

		<div class="mt-8 grid items-center gap-10 lg:grid-cols-[auto_1fr] lg:gap-16">
			<!-- Sleeve and record. The record slides out of the sleeve when it plays. -->
			<div class="flex justify-center lg:justify-start transition-transform duration-1000 ease-in-out motion-reduce:transition-none {player?.track ? '' : 'lg:translate-x-[65%]'}">
				<div class="relative size-52 sm:size-72 lg:size-80 transition-[margin] duration-1000 motion-reduce:transition-none {player?.track ? 'mr-16 sm:mr-24' : ''}">
					<div
						class="absolute inset-0 transition-transform duration-1000 ease-out motion-reduce:transition-none {playing && player?.track
							? 'translate-x-[30%]'
							: player?.track ? 'translate-x-[7%]' : 'translate-x-0'}"
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

					{#if player?.track && (image || !coverSource)}
					{#key image}
						<div class="absolute inset-0 z-10" in:fade={{ duration: 1200 }} out:fade={{ delay: 1200, duration: 0 }}>
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
					{:else if player && !player.track}
						<button
							onclick={startMix}
							disabled={busy !== null}
							aria-label={busy === 'mix' ? 'Starting playback' : 'Play'}
							class="idle-play vinyl-label text-cream focus-visible:outline-cream absolute top-1/2 left-1/2 z-20 flex size-[38%] -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full shadow-xl transition duration-200 hover:scale-110 hover:brightness-110 focus-visible:scale-110 focus-visible:outline-2 focus-visible:outline-offset-4 active:scale-95 disabled:cursor-wait disabled:opacity-70 motion-reduce:transition-none"
						>
							{#if busy === 'mix'}<IconLoader2 size={40} class="animate-spin" aria-hidden="true" />{:else}<IconPlayerPlayFilled size={40} class="translate-x-0.5" aria-hidden="true" />{/if}
						</button>
					{/if}
					{#if player?.track}
						<button
							class="bg-ink/70 text-cream hover:bg-moss focus-visible:outline-cream absolute right-3 bottom-3 z-20 flex size-11 items-center justify-center rounded-full shadow-lg backdrop-blur-md transition focus-visible:outline-2 focus-visible:outline-offset-2 active:scale-95 disabled:cursor-wait disabled:opacity-50"
							disabled={liking || !likeLoaded}
							onclick={likeCurrentTrack}
							title="{liked ? 'Unlike' : 'Like'} {player.track.title}"
							aria-label="{liked ? 'Unlike' : 'Like'} {player.track.title}"
							aria-pressed={liked}
						>
							{#if liked}<IconHeartFilled size={24} aria-hidden="true" />{:else}<IconHeart size={24} aria-hidden="true" />{/if}
						</button>
					{/if}
				</div>
			</div>

			{#if player?.track}
				<div class="min-w-0 text-center lg:text-left" in:fade={{ duration: 900, delay: 200 }}>
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
							onclick={() => action('clear')}
						>
							{#if busy === 'clear'}
								<IconLoader2 size={18} class="animate-spin" aria-hidden="true" />
							{:else}
								<IconPlayerStop size={18} aria-hidden="true" />
							{/if}
							Stop
						</button>
						<button
							class="hover:bg-cream/10 focus-visible:outline-cream inline-flex min-h-10 items-center gap-2 rounded-full px-3 transition focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40 {player.shuffle ? 'text-accent' : 'text-cream/60'}"
							disabled={busy !== null}
							onclick={toggleShuffle}
							aria-pressed={player.shuffle ?? false}
						>
							<IconArrowsShuffle size={18} aria-hidden="true" />
							Shuffle
						</button>
					</div>
				</div>
			{:else}
				<div class="min-w-0 text-center lg:text-left">
					{#if playing || player?.state === 'buffering' || !player}
					<h2 class="font-display text-4xl leading-[1.05] font-black text-balance sm:text-5xl">
						{playing
							? 'Playback is active'
							: player?.state === 'buffering'
								? 'Loading audio…'
								: player
									? 'Nothing playing'
									: 'Player unavailable'}
					</h2>
					{/if}
					{#if playing || !player}
						<p class="text-cream/65 mt-4 text-lg">
							{playing ? 'Track details are not available yet.' : 'Check the Music Assistant connection.'}
						</p>
					{/if}
				</div>
			{/if}
		</div>
	</div>
</section>

<style>
	.idle-play:not(:disabled)::before {
		content: '';
		position: absolute;
		inset: -7px;
		border: 1px solid rgb(255 253 245 / 35%);
		border-radius: 50%;
		pointer-events: none;
		animation: play-invitation 3s ease-out infinite;
	}

	@keyframes play-invitation {
		0% { transform: scale(0.94); opacity: 0; }
		20% { opacity: 0.65; }
		75%, 100% { transform: scale(1.25); opacity: 0; }
	}

	@media (prefers-reduced-motion: reduce) {
		.idle-play::before { animation: none; }
	}
</style>
