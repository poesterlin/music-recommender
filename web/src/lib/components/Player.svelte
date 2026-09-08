<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { post } from '$lib/api';

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
		track: Track | null;
	};

	let { initial }: { initial: State | null } = $props();

	let player = $state<State | null>(initial);
	let busy = $state<string | null>(null);
	let volume = $state<number | null>(initial?.volumeLevel ?? null);
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
		if (volumeTimer) clearTimeout(volumeTimer);
		volumeTimer = setTimeout(async () => {
			await post('/api/player', { volume });
		}, 400);
	}

	let poller: ReturnType<typeof setInterval> | null = null;
	let ticker: ReturnType<typeof setInterval> | null = null;

	onMount(() => {
		poller = setInterval(refresh, 10000);
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

<section class="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
	<h2 class="text-sm font-semibold tracking-wide text-gray-400 uppercase">
		Now playing{#if player} <span class="normal-case">on {player.playerName}</span>{/if}
	</h2>

	{#if player?.track}
		<div class="mt-3 flex items-center gap-4">
			{#if player.track.image}
				<img
					src={player.track.image}
					alt={player.track.album}
					class="h-20 w-20 rounded-xl object-cover shadow"
					loading="lazy"
				/>
			{:else}
				<div class="flex h-20 w-20 items-center justify-center rounded-xl bg-gray-100 text-2xl">🎵</div>
			{/if}
			<div class="min-w-0">
				<p class="truncate text-2xl font-bold text-gray-900">{player.track.title}</p>
				<p class="truncate text-gray-500">{player.track.artist}</p>
				<p class="truncate text-sm text-gray-400">{player.track.album}</p>
			</div>
			<span
				class="ml-auto shrink-0 rounded-full px-3 py-1 text-xs font-semibold {playing
					? 'bg-green-100 text-green-800'
					: 'bg-gray-100 text-gray-600'}"
			>
				{player.state}
			</span>
		</div>

		<!-- progress -->
		<div class="mt-4">
			<div class="h-1.5 overflow-hidden rounded-full bg-gray-100">
				<div
					class="h-full rounded-full bg-blue-600 transition-all"
					style="width: {duration ? Math.min(100, (elapsed / duration) * 100) : 0}%"
				></div>
			</div>
			<div class="mt-1 flex justify-between text-xs text-gray-400">
				<span>{fmt(elapsed)}</span>
				<span>{fmt(duration)}</span>
			</div>
		</div>

		<!-- transport -->
		<div class="mt-3 flex items-center gap-2">
			<button
				class="rounded-xl bg-gray-100 px-4 py-2.5 font-semibold text-gray-700 hover:bg-gray-200 disabled:opacity-50"
				disabled={busy !== null}
				onclick={() => action('previous')}
				title="Previous track"
			>
				⏮
			</button>
			<button
				class="rounded-xl bg-blue-600 px-6 py-2.5 font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
				disabled={busy !== null}
				onclick={() => action(playing ? 'pause' : 'play')}
				title={playing ? 'Pause' : 'Play'}
			>
				{busy ? '…' : playing ? '⏸ Pause' : '▶ Play'}
			</button>
			<button
				class="rounded-xl bg-gray-100 px-4 py-2.5 font-semibold text-gray-700 hover:bg-gray-200 disabled:opacity-50"
				disabled={busy !== null}
				onclick={() => action('next')}
				title="Next track"
			>
				⏭
			</button>
			<button
				class="rounded-xl bg-gray-100 px-4 py-2.5 font-semibold text-gray-700 hover:bg-gray-200 disabled:opacity-50"
				disabled={busy !== null}
				onclick={() => action('stop')}
				title="Stop"
			>
				⏹
			</button>

			{#if volume !== null}
				<label class="ml-auto flex items-center gap-2 text-sm text-gray-500">
					🔈
					<input
						type="range"
						min="0"
						max="100"
						step="1"
						bind:value={volume}
						oninput={onVolume}
						class="w-28 accent-blue-600"
					/>
					<span class="w-8 text-right tabular-nums">{volume}</span>
				</label>
			{/if}
		</div>
	{:else}
		<p class="mt-2 text-gray-400">Nothing playing right now. Start something below.</p>
	{/if}
</section>
