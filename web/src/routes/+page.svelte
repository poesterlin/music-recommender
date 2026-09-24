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
	<p class="ghost-type pointer-events-none absolute -top-6 right-0 hidden font-display text-[11rem] leading-none font-black tracking-tight select-none lg:block" aria-hidden="true">
		A-side
	</p>

	<div class="relative grid items-center gap-10 lg:grid-cols-[1.2fr_0.8fr]">
		<div class="animate-rise">
			<p class="mb-4 flex items-center gap-2 text-[11px] font-bold tracking-[0.28em] text-accent-deep uppercase">
				<span class="inline-block h-px w-8 bg-accent"></span>
				Tonight at the listening bar
			</p>
			<h1 class="font-display text-5xl leading-[0.98] font-black tracking-tight text-balance sm:text-7xl">
				Put the needle<br />
				on <em class="font-light text-accent-deep italic">your mood.</em>
			</h1>
			<p class="mt-5 max-w-xl text-lg leading-relaxed text-ink-soft">
				{slotLine}. {data.vibeClusterIds.length} clusters in rotation, {queuedTrackCount}
				{queuedTrackCount === 1 ? 'track' : 'tracks'} coming up — one tap and the room wakes up.
			</p>
			<div class="mt-7 flex flex-wrap gap-2.5">
				<button
					class="rounded-full bg-accent px-7 py-3 font-bold text-cream shadow-lg shadow-accent/30 transition hover:-translate-y-0.5 hover:bg-accent-deep disabled:cursor-wait disabled:opacity-60 disabled:hover:translate-y-0"
					disabled={vibeBusy}
					onclick={playVibe}>{vibeBusy ? 'Starting…' : '▶ Play the vibe'}</button
				>
				<button
					class="rounded-full bg-ink px-6 py-3 font-bold text-cream transition hover:-translate-y-0.5 hover:bg-ink-soft disabled:cursor-wait disabled:opacity-60 disabled:hover:translate-y-0"
					disabled={scheduledBusy}
					onclick={playScheduled}>{scheduledBusy ? 'Starting…' : 'Play scheduled slot'}</button
				>
			</div>
			<dl class="mt-8 flex flex-wrap gap-x-10 gap-y-3">
				<div>
					<dt class="text-[11px] font-bold tracking-[0.2em] text-faded uppercase">In rotation</dt>
					<dd class="font-display text-3xl font-black">{data.vibeClusterIds.length} <span class="text-base font-light italic text-faded">clusters</span></dd>
				</div>
				<div>
					<dt class="text-[11px] font-bold tracking-[0.2em] text-faded uppercase">Coming up</dt>
					<dd class="font-display text-3xl font-black">{queuedTrackLabel} <span class="text-base font-light italic text-faded">tracks</span></dd>
				</div>
				<div>
					<dt class="text-[11px] font-bold tracking-[0.2em] text-faded uppercase">On the slate</dt>
					<dd class="font-display text-3xl font-black">
						{data.activeSchedule ? data.activeSchedule.name : '∞'}
					</dd>
				</div>
			</dl>
		</div>

		<div class="relative mx-auto hidden w-full max-w-sm animate-rise lg:block" style="animation-delay: 120ms">
			<div class="vinyl animate-spin-slow aspect-square w-full rounded-full shadow-2xl ring-1 ring-ink/30">
				<div class="flex h-full w-full items-center justify-center">
					<div class="vinyl-label flex size-32 items-center justify-center rounded-full shadow-inner">
						<div class="flex size-28 flex-col items-center justify-center rounded-full bg-paper text-center">
							<p class="px-4 font-display text-sm leading-tight font-black text-ink">
								{data.activeSchedule?.name ?? 'Open Deck'}
							</p>
							<p class="mt-1 text-[10px] font-bold tracking-[0.2em] text-faded uppercase">
								33⅓ rpm
							</p>
							<div class="mt-1 size-2.5 rounded-full bg-ink"></div>
						</div>
					</div>
				</div>
			</div>
			<p class="mt-4 text-center font-display text-sm italic text-faded">
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

	<section class="animate-rise rounded-3xl border border-ink/15 bg-cream p-6 shadow-sm sm:p-7" style="animation-delay: 240ms">
		<h2 class="text-[11px] font-bold tracking-[0.28em] text-faded uppercase">On the slate</h2>
		{#if data.activeSchedule}
			<p class="mt-2 font-display text-3xl font-black">{data.activeSchedule.name}</p>
			<p class="mt-1 text-sm font-bold text-ink-soft">
				{data.activeSchedule.startHour}–{data.activeSchedule.endHour}h · {data.activeSchedule
					.clusterIds.length} clusters
			</p>
			<p class="mt-3 text-sm leading-relaxed text-ink-soft">
				{data.activeSchedule.clusterIds.map(clusterLabel).join(' · ')}
			</p>
		{:else}
			<p class="mt-2 font-display text-3xl font-black">Hand-picked</p>
			<p class="mt-1 text-sm font-bold text-ink-soft">
				No schedule slot matches this hour — your manual picks run the room.
			</p>
			<div class="mt-3 flex flex-wrap gap-1.5">
				{#each data.vibeClusterIds as id (id)}
					<a
						href="/vibe"
						class="rounded-full bg-ink/5 px-3 py-1 text-xs font-bold text-ink-soft transition hover:bg-ink hover:text-cream"
					>
						{clusterLabel(id)}
					</a>
				{/each}
			</div>
		{/if}
		<div class="mt-5 border-t border-ink/10 pt-4">
			<a href="/vibe" class="text-sm font-bold text-accent-deep underline-offset-4 hover:underline">
				Retune the vibe mixer →
			</a>
		</div>
	</section>
</div>

<!-- SETLIST — live Music Assistant queues, grouped by their active queue -->
<section class="mt-6 animate-rise rounded-3xl border border-ink/15 bg-cream p-6 shadow-sm sm:p-7" style="animation-delay: 300ms">
	<div class="mb-5 flex flex-wrap items-start justify-between gap-3">
		<div>
			<h2 class="font-display text-3xl font-black">Up next <span class="font-light text-faded italic">— the setlist</span></h2>
			<p class="mt-1 text-sm text-ink-soft">
				{#if queueState.scope === 'main'}
					Main device · {queueState.mainPlayer}
				{:else}
					{queueDeviceCount} {queueDeviceCount === 1 ? 'device' : 'devices'} · {queueState.queues.length}
					{queueState.queues.length === 1 ? 'queue' : 'queues'} · {queuedTrackLabel} tracks
				{/if}
			</p>
		</div>
		<div
			class="flex items-center gap-2 rounded-full bg-ink/5 px-3 py-1.5 text-[11px] font-bold tracking-[0.16em] text-faded uppercase"
			aria-live="polite"
		>
			<span class="relative flex size-2">
				{#if !queueUnavailable}
					<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60"></span>
				{/if}
				<span class="relative inline-flex size-2 rounded-full {queueUnavailable ? 'bg-accent' : 'bg-moss'}"></span>
			</span>
			{queueUnavailable ? 'Reconnecting' : queueRefreshing ? 'Syncing' : 'Live'}
		</div>
	</div>

	{#if queueState.queues.length > 0}
		<div class="grid gap-5 {queueState.scope === 'all' && queueState.queues.length > 1 ? 'lg:grid-cols-2' : ''}">
			{#each queueState.queues as queue (queue.queueId)}
				<article class="min-w-0 rounded-2xl border border-ink/10 bg-paper/45 p-4 sm:p-5">
					<div class="flex items-start justify-between gap-3">
						<div class="min-w-0">
							<p class="text-[10px] font-bold tracking-[0.22em] text-faded uppercase">
								{queue.playerNames.length > 1 ? 'Synced group' : 'Device queue'}
							</p>
							<h3 class="mt-1 truncate font-display text-xl font-black">{queue.playerNames.join(' + ')}</h3>
						</div>
						<span class="flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold capitalize {queue.state === 'playing'
								? 'bg-moss/15 text-moss'
								: queue.state === 'paused'
									? 'bg-gold/20 text-ink-soft'
									: 'bg-ink/5 text-faded'}">
							<span class="size-1.5 rounded-full {queue.state === 'playing' ? 'bg-moss' : 'bg-current'}"></span>
							{queueStateLabel(queue.state)}
						</span>
					</div>

					<div class="mt-4 rounded-xl bg-ink/[0.045] px-3 py-2.5">
						<p class="text-[10px] font-bold tracking-[0.2em] text-faded uppercase">
							{queue.state === 'playing' ? 'Now playing' : 'Current track'}
						</p>
						{#if queue.currentTrack}
							<div class="mt-1 flex items-center gap-3">
								<div class="min-w-0 flex-1">
									<p class="truncate font-bold">{queue.currentTrack.name}</p>
									<p class="truncate text-xs text-ink-soft">{queue.currentTrack.artists.join(', ')}</p>
								</div>
								{#if queue.currentTrack.uri}
									<button
										class="shrink-0 rounded-full bg-moss/10 px-3 py-1.5 text-xs font-bold text-moss transition hover:bg-moss hover:text-cream"
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
							<p class="mt-1 text-sm text-faded">Nothing is playing on this device.</p>
						{/if}
					</div>

					<div class="mb-1 mt-5 flex items-baseline justify-between gap-3">
						<h4 class="text-[11px] font-bold tracking-[0.22em] text-faded uppercase">Then play</h4>
						<p class="text-xs font-bold text-faded">{queue.tracks.length}{queue.hasMore ? '+' : ''} tracks</p>
					</div>
					<TrackList
						tracks={queue.tracks}
						onLike={likeTrackFromQueue}
						onJump={(track) => playQueuedTrack(queue.queueId, track)}
						emptyText="Nothing is lined up after this track."
					/>
					{#if queue.hasMore}
						<p class="mt-3 text-xs text-faded">More tracks are waiting in Music Assistant.</p>
					{/if}
				</article>
			{/each}
		</div>
	{:else}
		<div class="rounded-2xl border border-dashed border-ink/20 bg-cream/60 px-6 py-8 text-center">
			{#if queueUnavailable}
				<p class="text-sm font-bold text-ink-soft">Music Assistant is taking a moment.</p>
				<p class="mt-1 text-sm text-faded">The last queue is safe; this page will keep trying.</p>
			{:else if queueState.scope === 'main'}
				<p class="text-sm text-faded">No queue was found for {queueState.mainPlayer}.</p>
			{:else}
				<p class="text-sm text-faded">Music Assistant has no available device queues.</p>
			{/if}
			<button
				class="mt-4 rounded-full bg-accent px-6 py-2.5 font-bold text-cream shadow-lg shadow-accent/30 transition hover:-translate-y-0.5 hover:bg-accent-deep disabled:cursor-wait disabled:opacity-60 disabled:hover:translate-y-0"
				disabled={vibeBusy}
				onclick={playVibe}>{vibeBusy ? 'Starting…' : '▶ Play the vibe'}</button
			>
		</div>
	{/if}
</section>
