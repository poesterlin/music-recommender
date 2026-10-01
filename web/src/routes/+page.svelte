<script lang="ts">
	import { onMount } from 'svelte';
	import Player from '$lib/components/Player.svelte';
	import ScheduledVibes from '$lib/components/ScheduledVibes.svelte';
	import TrackList from '$lib/components/TrackList.svelte';
	import ClusterTile from '$lib/components/ClusterTile.svelte';
	import { IconArrowUpRight } from '@tabler/icons-svelte';
	import { likeTrack } from '$lib/client/like-track';
	import { toastStore } from '$lib/client/toast.svelte';
	import { nowPlayingStore } from '$lib/client/now-playing.svelte';
	import { post } from '$lib/api';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type QueueApiResponse = PageData['queueState'] & { success: boolean; error?: string };

	let liveQueueState = $state<PageData['queueState'] | null>(null);
	let queueRefreshing = $state(false);
	let queueUnavailable = $state(false);

	const queueState = $derived(liveQueueState ?? data.queueState);
	const queuedTrackCount = $derived(
		queueState.queues.reduce((total, queue) => total + queue.tracks.length, 0)
	);
	const queuedTrackLabel = $derived(
		`${queuedTrackCount}${queueState.queues.some((queue) => queue.hasMore) ? '+' : ''}`
	);
	const queueDeviceCount = $derived(
		new Set(queueState.queues.flatMap((queue) => queue.playerIds)).size
	);
	// No clusters means no vibes to play, whatever the stored default list says.
	const vibesReady = $derived(data.vibeClusterIds.length > 0);
	let startingVibe = $state<number | null>(null);
	// Saved picks lead, then whatever else the library has. Six fills one
	// row at the widest layout; the rest lives behind "Browse all".
	const allShelfIds = $derived([...new Set([...data.vibeClusterIds, ...data.availableClusterIds])]);
	const shelfIds = $derived(allShelfIds.slice(0, 6));

	async function playVibe(clusterId: number) {
		if (startingVibe !== null) return;
		startingVibe = clusterId;
		try {
			const { ok } = await post('/api/play-vibe', { clusterIds: [clusterId] });
			if (ok) {
				toastStore.show(`Playing ${data.clusterNames[clusterId] ?? `Cluster ${clusterId}`}`);
				await Promise.all([refreshQueues(), nowPlayingStore.refresh()]);
			}
		} finally {
			startingVibe = null;
		}
	}

	async function refreshQueues() {
		if (queueRefreshing) return;
		queueRefreshing = true;
		try {
			const response = await fetch('/api/queues', { cache: 'no-store' });
			const json = (await response.json().catch(() => null)) as QueueApiResponse | null;
			if (response.ok && json?.success) {
				liveQueueState = json;
				queueUnavailable = false;
			} else {
				queueUnavailable = true;
			}
		} catch {
			queueUnavailable = true;
		} finally {
			queueRefreshing = false;
		}
	}

	async function likeTrackFromQueue(uri: string, name?: string) {
		await likeTrack(uri, name);
	}

	async function playQueuedTrack(
		queueId: string,
		track: { queueItemId?: string | null; name: string }
	) {
		if (!track.queueItemId) return;
		const { ok } = await post('/api/queues/play', {
			queueId,
			queueItemId: track.queueItemId
		});
		if (ok) {
			toastStore.show(`Playing ${track.name} now`);
			await refreshQueues();
		}
	}

	function queueStateLabel(state: string): string {
		if (state === 'playing') return 'Playing';
		if (state === 'paused') return 'Paused';
		if (state === 'buffering') return 'Buffering';
		return state ? state.charAt(0).toUpperCase() + state.slice(1) : 'Idle';
	}

	let queueTimer: ReturnType<typeof setTimeout> | null = null;
	let queuePollingStopped = false;

	async function pollQueues() {
		await refreshQueues();
		if (!queuePollingStopped && !document.hidden) queueTimer = setTimeout(pollQueues, 5000);
	}

	onMount(() => {
		const onVisibilityChange = () => {
			if (queueTimer) clearTimeout(queueTimer);
			queueTimer = null;
			if (!document.hidden) void pollQueues();
		};

		void pollQueues();
		document.addEventListener('visibilitychange', onVisibilityChange);

		return () => {
			queuePollingStopped = true;
			if (queueTimer) clearTimeout(queueTimer);
			document.removeEventListener('visibilitychange', onVisibilityChange);
		};
	});
</script>

<h1 class="sr-only">Listen</h1>
{#if !vibesReady}
	<div
		class="border-accent/30 bg-accent/5 mb-8 flex flex-wrap items-center justify-between gap-4 rounded-2xl border px-5 py-4"
	>
		<div>
			<p class="font-bold">Your library needs setup</p>
			<p class="text-ink-soft text-sm">
				Connect your music, import tracks, then build your first vibe.
			</p>
		</div>
		<a href="/setup" class="bg-ink text-cream rounded-full px-4 py-2 text-sm font-bold"
			>Open setup →</a
		>
	</div>
{/if}

<!-- STAGE — the current song and the play button are the page -->
<Player initial={data.player} onQueueChange={refreshQueues} />

<div class="mt-6">
	<ScheduledVibes
		schedules={data.vibeSchedules}
		active={data.activeSchedule}
		picks={data.vibeClusterIds}
		names={data.clusterNames}
		covers={data.covers}
		timezone={data.scheduleTimezone}
		onPlay={async () => {
			await Promise.all([refreshQueues(), nowPlayingStore.refresh()]);
		}}
	/>
</div>

<!-- CRATE — the Browse sleeves, one tap to play -->
{#if shelfIds.length}
	<section class="mt-14" aria-labelledby="shelf-title" aria-busy={startingVibe !== null}>
		<div class="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
			<div>
				<h2 id="shelf-title" class="font-display text-2xl font-black">Your vibes</h2>
				<p class="text-ink-soft mt-1 text-sm" aria-live="polite">
					{startingVibe !== null
						? `Starting ${data.clusterNames[startingVibe] ?? `Cluster ${startingVibe}`}…`
						: 'Tap a sleeve to start playing it.'}
				</p>
			</div>
			<a
				href="/vibe?tab=browse"
				class="text-ink hover:text-accent-deep inline-flex min-h-11 items-center gap-1.5 text-sm font-bold transition"
			>
				{allShelfIds.length > shelfIds.length ? `Browse all ${allShelfIds.length}` : 'Browse vibes'}
				<IconArrowUpRight size={18} aria-hidden="true" />
			</a>
		</div>
		<div class="grid grid-cols-2 gap-5 sm:grid-cols-3 lg:grid-cols-6">
			{#each shelfIds as id (id)}
				<ClusterTile
					clusterId={id}
					name={data.clusterNames[id] ?? `Cluster ${id}`}
					covers={data.covers[id] ?? { primary: null, secondary: null }}
					trackCount={data.trackCounts[id]}
					selected={startingVibe === id}
					playable
					disabled={startingVibe !== null}
					onselect={playVibe}
				/>
			{/each}
		</div>
	</section>
{/if}

<!-- SETLIST — live Music Assistant queues, grouped by their active queue -->
<section class="border-ink/15 mt-14 border-t pt-8">
	<div class="mb-5 flex flex-wrap items-start justify-between gap-3">
		<div>
			<h2 class="font-display text-2xl font-black">Up next</h2>
			<p class="text-ink-soft mt-1 text-sm">
				{#if queueState.scope === 'main'}
					Main device · {queueState.mainPlayer}
				{:else}
					{queueDeviceCount}
					{queueDeviceCount === 1 ? 'device' : 'devices'} · {queueState.queues.length}
					{queueState.queues.length === 1 ? 'queue' : 'queues'} · {queuedTrackLabel} tracks
				{/if}
			</p>
		</div>
		<div class="flex size-4 shrink-0 items-center justify-center">
			{#if queueRefreshing}
				<span role="status">
					<span class="sr-only">Loading queue</span>
					<span
						aria-hidden="true"
						class="border-ink/15 border-t-accent block size-4 animate-spin rounded-full border-2 motion-reduce:animate-none"
					></span>
				</span>
			{/if}
		</div>
	</div>

	{#if queueState.queues.length > 0}
		<div
			class="grid gap-5 {queueState.scope === 'all' && queueState.queues.length > 1
				? 'lg:grid-cols-2'
				: ''}"
		>
			{#each queueState.queues as queue (queue.queueId)}
				<article
					class="border-ink/15 bg-cream relative min-w-0 overflow-hidden rounded-xl border shadow-[0_6px_14px_-8px_rgba(29,21,14,0.5)]"
				>
					<!-- Same crease the sleeves use between cover and label. -->
					<div
						class="pointer-events-none absolute inset-x-0 top-0 h-1 {queue.state === 'playing'
							? 'bg-accent'
							: 'bg-ink/10'}"
					></div>
					<div class="p-4 pt-5 sm:p-5 sm:pt-6">
						<div class="flex items-start justify-between gap-3">
							<div class="min-w-0">
								<p class="text-faded text-[10px] font-bold tracking-[0.22em] uppercase">
									{queue.playerNames.length > 1 ? 'Synced group' : 'Device queue'}
								</p>
								<h3 class="font-display mt-1 truncate text-xl font-black">
									{queue.playerNames.join(' + ')}
								</h3>
							</div>
							<span
								class="flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold capitalize {queue.state ===
								'playing'
									? 'bg-moss/15 text-moss'
									: queue.state === 'paused'
										? 'bg-gold/20 text-ink-soft'
										: 'bg-ink/5 text-faded'}"
							>
								<span
									class="size-1.5 rounded-full {queue.state === 'playing'
										? 'bg-moss'
										: 'bg-current'}"
								></span>
								{queueStateLabel(queue.state)}
							</span>
						</div>

						<div class="bg-ink/[0.045] mt-4 rounded-xl px-3 py-2.5">
							<p class="text-faded text-[10px] font-bold tracking-[0.2em] uppercase">
								{queue.state === 'playing' ? 'Now playing' : 'Current track'}
							</p>
							{#if queue.currentTrack}
								<div class="mt-1 flex items-center gap-3">
									<div class="min-w-0 flex-1">
										<p class="truncate font-bold">{queue.currentTrack.name}</p>
										<p class="text-ink-soft truncate text-xs">
											{queue.currentTrack.artists.join(', ')}
										</p>
									</div>
									{#if queue.currentTrack.uri}
										<button
											class="bg-moss/10 text-moss hover:bg-moss hover:text-cream shrink-0 rounded-full px-3 py-1.5 text-xs font-bold transition"
											onclick={() => {
												const uri = queue.currentTrack?.uri;
												if (uri) void likeTrack(uri, queue.currentTrack?.name);
											}}
											title="Like {queue.currentTrack.name}"
										>
											♥ Like
										</button>
									{/if}
								</div>
							{:else}
								<p class="text-faded mt-1 text-sm">Nothing is playing on this device.</p>
							{/if}
						</div>

						<div class="mt-5 mb-1 flex items-baseline justify-between gap-3">
							<h4 class="text-faded text-[11px] font-bold tracking-[0.22em] uppercase">
								Then play
							</h4>
							<p class="text-faded text-xs font-bold">
								{queue.tracks.length}{queue.hasMore ? '+' : ''} tracks
							</p>
						</div>
						<TrackList
							tracks={queue.tracks}
							onLike={likeTrackFromQueue}
							onJump={(track) => playQueuedTrack(queue.queueId, track)}
							emptyText="Nothing is lined up after this track."
						/>
						{#if queue.hasMore}
							<p class="text-faded mt-3 text-xs">More tracks are waiting in Music Assistant.</p>
						{/if}
					</div>
				</article>
			{/each}
		</div>
	{:else}
		<div class="border-ink/20 bg-cream/60 rounded-2xl border border-dashed px-6 py-8 text-center">
			{#if !data.musicAssistant}
				<p class="text-ink-soft text-sm font-bold">Music Assistant is not connected.</p>
				<a class="text-accent-deep mt-2 inline-block text-sm font-bold" href="/setup"
					>Open setup →</a
				>
			{:else if queueUnavailable}
				<p class="text-ink-soft text-sm font-bold">Music Assistant is taking a moment.</p>
				<p class="text-faded mt-1 text-sm">The last queue is safe; this page will keep trying.</p>
			{:else if queueState.scope === 'main'}
				<p class="text-faded text-sm">No queue was found for {queueState.mainPlayer}.</p>
			{:else}
				<p class="text-faded text-sm">Music Assistant has no available device queues.</p>
			{/if}
		</div>
	{/if}
</section>
