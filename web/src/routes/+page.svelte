<script lang="ts">
	import { onMount } from 'svelte';
	import Player from '$lib/components/Player.svelte';
	import TrackList from '$lib/components/TrackList.svelte';
	import { likeTrack } from '$lib/client/like-track';
	import { toastStore } from '$lib/client/toast.svelte';
	import { post } from '$lib/api';
	import { clusterLabel } from '$lib/clusters';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type QueueApiResponse = PageData['queueState'] & { success: boolean; error?: string };

	let liveQueueState = $state<PageData['queueState'] | null>(null);
	let queueRefreshing = $state(false);
	let queueUnavailable = $state(false);
	let vibeBusy = $state(false);
	let scheduledBusy = $state(false);

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
	const slotLine = $derived(
		data.activeSchedule
			? `${data.activeSchedule.name} · ${data.activeSchedule.startHour}–${data.activeSchedule.endHour}h`
			: 'Open deck · your hand-picked clusters'
	);

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

	async function playVibe() {
		vibeBusy = true;
		try {
			const { ok, data: json } = await post<{ tracks?: unknown[] }>('/api/play-vibe', {
				clusterIds: data.vibeClusterIds
			});
			if (ok) {
				toastStore.show(`Playing vibe (${(json.tracks ?? []).length} tracks)`);
				await refreshQueues();
			}
		} finally {
			vibeBusy = false;
		}
	}

	async function playScheduled() {
		scheduledBusy = true;
		try {
			const { ok } = await post('/api/play-vibe', { useSchedule: true });
			if (ok) {
				toastStore.show('Playing scheduled slot');
				await refreshQueues();
			}
		} finally {
			scheduledBusy = false;
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

<!-- HERO -->
<section class="relative overflow-hidden">
	<p
		class="ghost-type font-display pointer-events-none absolute -top-6 right-0 hidden text-[11rem] leading-none font-black tracking-tight select-none lg:block"
		aria-hidden="true"
	>
		A-side
	</p>

	<div class="relative grid items-center gap-10 lg:grid-cols-[1.2fr_0.8fr]">
		<div class="animate-rise">
			<p
				class="text-accent-deep mb-4 flex items-center gap-2 text-[11px] font-bold tracking-[0.28em] uppercase"
			>
				<span class="bg-accent inline-block h-px w-8"></span>
				Tonight at the listening bar
			</p>
			<h1
				class="font-display text-5xl leading-[0.98] font-black tracking-tight text-balance sm:text-7xl"
			>
				Put the needle<br />
				on <em class="text-accent-deep font-light italic">your mood.</em>
			</h1>
			<p class="text-ink-soft mt-5 max-w-xl text-lg leading-relaxed">
				{slotLine}. {data.vibeClusterIds.length} clusters in rotation, {queuedTrackCount}
				{queuedTrackCount === 1 ? 'track' : 'tracks'} coming up — one tap and the room wakes up.
			</p>
			<div class="mt-7 flex flex-wrap gap-2.5">
				<button
					class="bg-accent text-cream shadow-accent/30 hover:bg-accent-deep rounded-full px-7 py-3 font-bold shadow-lg transition hover:-translate-y-0.5 disabled:cursor-wait disabled:opacity-60 disabled:hover:translate-y-0"
					disabled={vibeBusy}
					onclick={playVibe}>{vibeBusy ? 'Starting…' : '▶ Play the vibe'}</button
				>
				<button
					class="bg-ink text-cream hover:bg-ink-soft rounded-full px-6 py-3 font-bold transition hover:-translate-y-0.5 disabled:cursor-wait disabled:opacity-60 disabled:hover:translate-y-0"
					disabled={scheduledBusy}
					onclick={playScheduled}>{scheduledBusy ? 'Starting…' : 'Play scheduled slot'}</button
				>
			</div>
			<dl class="mt-8 flex flex-wrap gap-x-10 gap-y-3">
				<div>
					<dt class="text-faded text-[11px] font-bold tracking-[0.2em] uppercase">In rotation</dt>
					<dd class="font-display text-3xl font-black">
						{data.vibeClusterIds.length}
						<span class="text-faded text-base font-light italic">clusters</span>
					</dd>
				</div>
				<div>
					<dt class="text-faded text-[11px] font-bold tracking-[0.2em] uppercase">Coming up</dt>
					<dd class="font-display text-3xl font-black">
						{queuedTrackLabel} <span class="text-faded text-base font-light italic">tracks</span>
					</dd>
				</div>
				<div>
					<dt class="text-faded text-[11px] font-bold tracking-[0.2em] uppercase">On the slate</dt>
					<dd class="font-display text-3xl font-black">
						{data.activeSchedule ? data.activeSchedule.name : '∞'}
					</dd>
				</div>
			</dl>
		</div>

		<div
			class="animate-rise relative mx-auto hidden w-full max-w-sm lg:block"
			style="animation-delay: 120ms"
		>
			<div
				class="vinyl animate-spin-slow ring-ink/30 aspect-square w-full rounded-full shadow-2xl ring-1"
			>
				<div class="flex h-full w-full items-center justify-center">
					<div
						class="vinyl-label flex size-32 items-center justify-center rounded-full shadow-inner"
					>
						<div
							class="bg-paper flex size-28 flex-col items-center justify-center rounded-full text-center"
						>
							<p class="font-display text-ink px-4 text-sm leading-tight font-black">
								{data.activeSchedule?.name ?? 'Open Deck'}
							</p>
							<p class="text-faded mt-1 text-[10px] font-bold tracking-[0.2em] uppercase">
								33⅓ rpm
							</p>
							<div class="bg-ink mt-1 size-2.5 rounded-full"></div>
						</div>
					</div>
				</div>
			</div>
			<p class="font-display text-faded mt-4 text-center text-sm italic">
				{data.nowPlaying ? `spinning now: ${data.nowPlaying.name}` : 'the deck is quiet — for now'}
			</p>
		</div>
	</div>
</section>

<!-- BOOTH + SLATE -->
<div class="mt-10 grid items-start gap-6 lg:grid-cols-2">
	<div class="animate-rise" style="animation-delay: 180ms">
		<Player initial={data.player} onQueueChange={refreshQueues} />
	</div>

	<section
		class="animate-rise border-ink/15 bg-cream rounded-3xl border p-6 shadow-sm sm:p-7"
		style="animation-delay: 240ms"
	>
		<h2 class="text-faded text-[11px] font-bold tracking-[0.28em] uppercase">On the slate</h2>
		{#if data.activeSchedule}
			<p class="font-display mt-2 text-3xl font-black">{data.activeSchedule.name}</p>
			<p class="text-ink-soft mt-1 text-sm font-bold">
				{data.activeSchedule.startHour}–{data.activeSchedule.endHour}h · {data.activeSchedule
					.clusterIds.length} clusters
			</p>
			<p class="text-ink-soft mt-3 text-sm leading-relaxed">
				{data.activeSchedule.clusterIds.map(clusterLabel).join(' · ')}
			</p>
		{:else}
			<p class="font-display mt-2 text-3xl font-black">Hand-picked</p>
			<p class="text-ink-soft mt-1 text-sm font-bold">
				No schedule slot matches this hour — your manual picks run the room.
			</p>
			<div class="mt-3 flex flex-wrap gap-1.5">
				{#each data.vibeClusterIds as id (id)}
					<a
						href="/vibe"
						class="bg-ink/5 text-ink-soft hover:bg-ink hover:text-cream rounded-full px-3 py-1 text-xs font-bold transition"
					>
						{clusterLabel(id)}
					</a>
				{/each}
			</div>
		{/if}
		<div class="border-ink/10 mt-5 border-t pt-4">
			<a href="/vibe" class="text-accent-deep text-sm font-bold underline-offset-4 hover:underline">
				Retune the vibe mixer →
			</a>
		</div>
	</section>
</div>

<!-- SETLIST — live Music Assistant queues, grouped by their active queue -->
<section
	class="animate-rise border-ink/15 bg-cream mt-6 rounded-3xl border p-6 shadow-sm sm:p-7"
	style="animation-delay: 300ms"
>
	<div class="mb-5 flex flex-wrap items-start justify-between gap-3">
		<div>
			<h2 class="font-display text-3xl font-black">
				Up next <span class="text-faded font-light italic">— the setlist</span>
			</h2>
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
		<div
			class="bg-ink/5 text-faded flex items-center gap-2 rounded-full px-3 py-1.5 text-[11px] font-bold tracking-[0.16em] uppercase"
			aria-live="polite"
		>
			<span class="relative flex size-2">
				{#if !queueUnavailable}
					<span
						class="bg-accent absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
					></span>
				{/if}
				<span
					class="relative inline-flex size-2 rounded-full {queueUnavailable
						? 'bg-accent'
						: 'bg-moss'}"
				></span>
			</span>
			{queueUnavailable ? 'Reconnecting' : queueRefreshing ? 'Syncing' : 'Live'}
		</div>
	</div>

	{#if queueState.queues.length > 0}
		<div
			class="grid gap-5 {queueState.scope === 'all' && queueState.queues.length > 1
				? 'lg:grid-cols-2'
				: ''}"
		>
			{#each queueState.queues as queue (queue.queueId)}
				<article class="border-ink/10 bg-paper/45 min-w-0 rounded-2xl border p-4 sm:p-5">
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
								class="size-1.5 rounded-full {queue.state === 'playing' ? 'bg-moss' : 'bg-current'}"
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
						<h4 class="text-faded text-[11px] font-bold tracking-[0.22em] uppercase">Then play</h4>
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
				</article>
			{/each}
		</div>
	{:else}
		<div class="border-ink/20 bg-cream/60 rounded-2xl border border-dashed px-6 py-8 text-center">
			{#if queueUnavailable}
				<p class="text-ink-soft text-sm font-bold">Music Assistant is taking a moment.</p>
				<p class="text-faded mt-1 text-sm">The last queue is safe; this page will keep trying.</p>
			{:else if queueState.scope === 'main'}
				<p class="text-faded text-sm">No queue was found for {queueState.mainPlayer}.</p>
			{:else}
				<p class="text-faded text-sm">Music Assistant has no available device queues.</p>
			{/if}
			<button
				class="bg-accent text-cream shadow-accent/30 hover:bg-accent-deep mt-4 rounded-full px-6 py-2.5 font-bold shadow-lg transition hover:-translate-y-0.5 disabled:cursor-wait disabled:opacity-60 disabled:hover:translate-y-0"
				disabled={vibeBusy}
				onclick={playVibe}>{vibeBusy ? 'Starting…' : '▶ Play the vibe'}</button
			>
		</div>
	{/if}
</section>
