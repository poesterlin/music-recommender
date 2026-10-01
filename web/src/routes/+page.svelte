<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import Player from '$lib/components/Player.svelte';
	import ScheduledVibes from '$lib/components/ScheduledVibes.svelte';
	import TrackList from '$lib/components/TrackList.svelte';
	import ClusterTile from '$lib/components/ClusterTile.svelte';
	import { likeTrack } from '$lib/client/like-track';
	import { toastStore } from '$lib/client/toast.svelte';
	import { nowPlayingStore } from '$lib/client/now-playing.svelte';
	import { api, post } from '$lib/api';
	import { coverUrl } from '$lib/cover-image';
	import { IconArrowRight, IconDisc, IconMusic } from '@tabler/icons-svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type QueueApiResponse = PageData['queueState'] & { success: boolean; error?: string };

	let liveQueueState = $state<PageData['queueState'] | null>(null);
	let queueRefreshing = $state(false);
	let queueUnavailable = $state(false);
	let previewingId = $state<number | null>(null);

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
	const named = $derived(new Set(data.namedClusterIds ?? []));

	function clusterName(id: number): string {
		return data.clusterNames[id] ?? `Cluster ${id}`;
	}

	const vibeNames = $derived(data.availableClusterIds.map((id) => clusterName(id)));
	const crateIds = $derived(data.availableClusterIds.slice(0, 10));
	const hasCrates = $derived(crateIds.length > 0);

	// Hero sleeve shows the current slot's first cluster, falling back to the
	// first crate. It borrows the Browse tile's sleeve language at hero scale.
	const heroClusterId = $derived(
		data.activeSchedule?.clusterIds[0] ?? data.vibeClusterIds[0] ?? crateIds[0] ?? null
	);
	const heroCovers = $derived(
		heroClusterId !== null
			? (data.covers[heroClusterId] ?? { primary: null, secondary: null })
			: { primary: null, secondary: null }
	);
	const heroPrimary = $derived(coverUrl(heroCovers.primary, 512));
	const heroSecondary = $derived(coverUrl(heroCovers.secondary, 256));
	const heroPlaying = $derived((nowPlayingStore.track ?? data.nowPlaying) !== null);
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

	async function playVibe() {
		const { ok, data: json } = await post<{ tracks?: unknown[] }>('/api/play-vibe', {});
		if (ok) {
			toastStore.show(`Playing vibe (${(json.tracks ?? []).length} tracks)`);
			await Promise.all([refreshQueues(), nowPlayingStore.refresh()]);
		}
	}

	async function previewCrate(clusterId: number) {
		if (previewingId !== null) return;
		previewingId = clusterId;
		try {
			const { ok, data: json } = await api<{
				tracks: Array<{ uri: string }>;
			}>(`/api/sample-cluster?clusterId=${clusterId}`);
			if (!ok || !json.tracks.length) {
				toastStore.show('No preview tracks in this crate yet');
				return;
			}
			const played = await post('/api/player', {
				uris: json.tracks.map((t) => t.uri)
			});
			if (played.ok) {
				toastStore.show(`Previewing #${clusterId} ${clusterName(clusterId)}`);
				await Promise.all([refreshQueues(), nowPlayingStore.refresh()]);
			}
		} finally {
			previewingId = null;
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

<!-- HERO — editorial headline with a Browse-style sleeve -->
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

<section class="relative overflow-hidden">
	<p
		class="ghost-type font-display pointer-events-none absolute -top-6 right-0 hidden leading-none font-black tracking-tight select-none lg:block"
		style="font-size: 10rem"
		aria-hidden="true"
	>
		A-side
	</p>

	<div class="relative grid items-center gap-10 lg:grid-cols-[1.15fr_0.85fr]">
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
				{slotLine}. {data.vibeClusterIds.length} clusters in rotation, {queuedTrackLabel} tracks
				cued — one tap and the room wakes up.
			</p>
			<div class="mt-7 flex flex-wrap gap-2.5">
				<button
					class="bg-accent text-cream shadow-accent/30 hover:bg-accent-deep rounded-full px-7 py-3 font-bold shadow-lg transition hover:-translate-y-0.5"
					onclick={playVibe}>▶ Play the vibe</button
				>
				<a
					href="/vibe?tab=browse"
					class="border-ink/15 text-ink hover:border-ink rounded-full border-2 px-6 py-3 font-bold transition hover:-translate-y-0.5"
					>Dig the crates</a
				>
			</div>
			<dl class="mt-8 flex flex-wrap gap-x-10 gap-y-3">
				<div>
					<dt class="text-faded text-[11px] font-bold tracking-[0.2em] uppercase">
						In rotation
					</dt>
					<dd class="font-display text-3xl font-black">
						{data.vibeClusterIds.length}
						<span class="text-faded text-base font-light italic">clusters</span>
					</dd>
				</div>
				<div>
					<dt class="text-faded text-[11px] font-bold tracking-[0.2em] uppercase">Cued up</dt>
					<dd class="font-display text-3xl font-black">
						{queuedTrackLabel}
						<span class="text-faded text-base font-light italic">tracks</span>
					</dd>
				</div>
				<div>
					<dt class="text-faded text-[11px] font-bold tracking-[0.2em] uppercase">On the slate</dt>
					<dd class="font-display text-3xl font-black">
						{data.activeSchedule
							? `${data.activeSchedule.startHour}–${data.activeSchedule.endHour}h`
							: '∞'}
					</dd>
				</div>
			</dl>
		</div>

		<!-- Hero sleeve: same object language as ClusterTile, scaled up. -->
		<div
			class="group relative mx-auto hidden w-full max-w-sm [perspective:900px] lg:block animate-rise"
			style="animation-delay: 120ms"
		>
			<div
				class="border-ink/15 relative overflow-hidden rounded-xl border shadow-[0_24px_45px_-18px_rgba(29,21,14,0.55)] transition-all duration-300 ease-out group-hover:-translate-y-1.5 group-hover:rotate-[-1.1deg]"
			>
				<div class="bg-line/40 relative aspect-square w-full overflow-hidden">
					<div class="pointer-events-none absolute inset-0 z-0 flex items-center justify-center">
						<div
							class="relative aspect-square w-[86%] transition-transform duration-500 ease-out group-hover:translate-x-[30%] {heroPlaying
								? 'translate-x-[30%]'
								: ''}"
						>
							<div
								class="animate-vinyl relative size-full rounded-full motion-reduce:animate-none"
							>
								<div
									class="absolute inset-0 rounded-full bg-[repeating-radial-gradient(circle_at_center,#171009_0_1.5px,#2c2117_1.5px_3px)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07),inset_0_0_26px_rgba(0,0,0,0.85)]"
								></div>
								<div
									class="absolute inset-0 rounded-full bg-[conic-gradient(from_0deg,rgba(255,255,255,0.16)_0deg,rgba(255,255,255,0)_55deg,rgba(255,255,255,0)_180deg,rgba(255,255,255,0.13)_205deg,rgba(255,255,255,0)_260deg,rgba(255,255,255,0)_360deg)]"
								></div>
								<div
									class="absolute inset-[36%] rounded-full bg-[#e8490f] shadow-[inset_0_1px_0_rgba(255,255,255,0.35),inset_0_-2px_4px_rgba(120,30,4,0.55),0_0_0_1px_rgba(29,21,14,0.45)]"
								>
									<div
										class="absolute inset-[42%] rounded-full bg-[#0d0906] shadow-[inset_0_1px_2px_rgba(0,0,0,0.9)]"
									></div>
								</div>
							</div>
						</div>
					</div>

					{#if heroPrimary}
						<img
							src={heroPrimary}
							alt=""
							class="relative z-10 size-full object-cover shadow-[0_2px_8px_rgba(0,0,0,0.35)] transition-transform duration-500 ease-out group-hover:-translate-x-[10%] group-hover:scale-[1.04]"
						/>
					{:else}
						<div class="text-faded bg-cream/70 absolute inset-0 z-10 flex items-center justify-center">
							<IconMusic size={64} stroke={1} />
						</div>
					{/if}

					{#if heroSecondary}
						<img
							src={heroSecondary}
							alt=""
							class="border-cream absolute right-2 bottom-2 z-20 size-1/4 rounded-md border-2 object-cover shadow-[0_4px_10px_rgba(0,0,0,0.45)]"
						/>
					{/if}

					<div
						class="pointer-events-none absolute inset-0 z-30 bg-[linear-gradient(115deg,rgba(255,255,255,0.22)_0%,rgba(255,255,255,0)_42%,rgba(0,0,0,0.12)_100%)]"
					></div>
					<div
						class="pointer-events-none absolute inset-y-0 left-0 z-30 w-[7px] bg-[linear-gradient(90deg,rgba(255,255,255,0.30),rgba(255,255,255,0)_78%)]"
					></div>
					<div
						class="pointer-events-none absolute inset-0 z-30 shadow-[inset_0_1px_0_rgba(255,255,255,0.28),inset_0_-2px_6px_rgba(29,21,14,0.22)]"
					></div>
				</div>

				<div
					class="pointer-events-none relative z-20 h-[3px] shrink-0 bg-[linear-gradient(180deg,rgba(29,21,14,0.34)_0%,rgba(29,21,14,0.10)_55%,rgba(255,255,255,0.45)_100%)]"
				></div>

				<div class="bg-cream relative px-4 pt-2.5 pb-3">
					<div
						class="pointer-events-none absolute inset-x-0 top-0 h-2.5 bg-[linear-gradient(180deg,rgba(29,21,14,0.20),rgba(29,21,14,0))]"
					></div>
					<p class="text-faded font-mono text-[11px]">
						{#if heroClusterId !== null}#{heroClusterId}{/if} · Now on the deck
					</p>
					<p class="font-display relative text-lg leading-snug font-black">
						{data.activeSchedule?.name ?? 'Open Deck'}
					</p>
					<p class="text-ink-soft mt-0.5 text-sm font-bold">
						{data.activeSchedule
							? `${data.activeSchedule.startHour}:00–${data.activeSchedule.endHour}:00 · ${data.activeSchedule.clusterIds.length} clusters`
							: `${data.vibeClusterIds.length} hand-picked clusters`}
					</p>
				</div>
			</div>
			<p class="text-faded font-display mt-4 text-center text-sm italic">
				{data.nowPlaying ? `spinning now: ${data.nowPlaying.name}` : 'the deck is quiet — for now'}
			</p>
		</div>
	</div>
</section>

<!-- MARQUEE — vibe names as a record-shop ticker -->
{#if vibeNames.length}
	<div class="relative -mx-6 mt-10 overflow-hidden" aria-hidden="true">
		<div class="bg-ink text-cream -rotate-1 border-y-2 border-ink py-2.5">
			<div class="animate-marquee flex w-max gap-0 whitespace-nowrap">
				{#each [0, 1] as copy (copy)}
					<span class="font-display text-lg font-bold tracking-wide">
						{#each vibeNames as n (n)}
							<span class="mx-4">{n}</span><span class="text-accent">✦</span>
						{/each}
					</span>
				{/each}
			</div>
		</div>
	</div>
{/if}

<!-- DECK — schedule + booth player -->
<div class="mt-10 grid items-start gap-6 lg:grid-cols-[1.2fr_0.8fr]">
	<div class="animate-rise" style="animation-delay: 180ms">
		<ScheduledVibes
			schedules={data.vibeSchedules}
			active={data.activeSchedule}
			picks={data.vibeClusterIds}
			names={data.clusterNames}
			timezone={data.scheduleTimezone}
			onPlay={async () => {
				await Promise.all([refreshQueues(), nowPlayingStore.refresh()]);
			}}
		/>
	</div>
	<div class="animate-rise" style="animation-delay: 240ms">
		<Player initial={data.player} onQueueChange={refreshQueues} />
	</div>
</div>

<!-- CRATES — Browse tiles as a home teaser -->
{#if hasCrates}
	<section class="animate-rise mt-10" style="animation-delay: 260ms">
		<div class="mb-4 flex flex-wrap items-end justify-between gap-3">
			<div>
				<p
					class="text-accent-deep flex items-center gap-2 text-[11px] font-bold tracking-[0.28em] uppercase"
				>
					<IconDisc size={14} />
					Dig the crates
				</p>
				<h2 class="font-display mt-2 text-3xl font-black">
					Fresh wax <span class="text-faded font-light italic">— browse the vibes</span>
				</h2>
				<p class="text-ink-soft mt-1 max-w-2xl text-sm">
					The same sleeves as the Browse tab. Hover to slide the record out, preview a
					sample, or open the full crate.
				</p>
			</div>
			<a
				href="/vibe?tab=browse"
				class="bg-ink text-cream hover:bg-ink-soft inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-bold transition"
			>
				Open all {data.availableClusterIds.length} crates
				<IconArrowRight size={16} />
			</a>
		</div>

		<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
			{#each crateIds as id (id)}
				<ClusterTile
					clusterId={id}
					name={clusterName(id)}
					trackCount={data.trackCounts[id] ?? null}
					covers={data.covers[id] ?? { primary: null, secondary: null }}
					named={named.has(id)}
					playing={previewingId === id}
					onselect={(selected) => goto(`/vibe?tab=browse`)}
					onpreview={previewCrate}
				/>
			{/each}
		</div>
	</section>
{/if}

<!-- SETLIST — live Music Assistant queues as one big sleeve -->
<section
	class="animate-rise border-ink/15 bg-cream mt-6 overflow-hidden rounded-3xl border shadow-sm"
	style="animation-delay: 300ms"
>
	<div class="relative p-6 sm:p-7">
		<div
			class="pointer-events-none absolute inset-0 bg-[linear-gradient(115deg,rgba(255,255,255,0.22)_0%,rgba(255,255,255,0)_42%,rgba(0,0,0,0.06)_100%)]"
		></div>
		<div
			class="pointer-events-none absolute inset-y-0 left-0 w-[7px] bg-[linear-gradient(90deg,rgba(255,255,255,0.30),rgba(255,255,255,0)_78%)]"
		></div>
		<div class="relative mb-5 flex flex-wrap items-start justify-between gap-3">
			<div>
				<p class="text-faded text-[11px] font-bold tracking-[0.28em] uppercase">
					Live from the booth
				</p>
				<h2 class="font-display mt-1 text-3xl font-black">
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
				class="relative grid gap-5 {queueState.scope === 'all' && queueState.queues.length > 1
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
					</article>
				{/each}
			</div>
		{:else}
			<div
				class="border-ink/20 bg-cream/60 relative rounded-2xl border border-dashed px-6 py-8 text-center"
			>
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
	</div>

	<div
		class="pointer-events-none relative h-[3px] shrink-0 bg-[linear-gradient(180deg,rgba(29,21,14,0.34)_0%,rgba(29,21,14,0.10)_55%,rgba(255,255,255,0.45)_100%)]"
	></div>
	<div class="bg-paper/60 relative flex flex-wrap items-center justify-between gap-2 px-6 py-3 sm:px-7">
		<p class="text-faded text-xs font-bold tracking-[0.18em] uppercase">
			Side B · live queues · {queuedTrackLabel} tracks
		</p>
		<a
			href="/vibe?tab=browse"
			class="text-accent-deep text-xs font-bold underline underline-offset-4"
			>Browse vibes to refill the setlist →</a
		>
	</div>
</section>
