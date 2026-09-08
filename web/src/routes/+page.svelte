<script lang="ts">
	import Player from '$lib/components/Player.svelte';
	import TrackList from '$lib/components/TrackList.svelte';
	import { toastStore } from '$lib/client/toast.svelte';
	import { post } from '$lib/api';
	import { clusterLabel } from '$lib/clusters';

	let { data } = $props();

	const slotLine = $derived(
		data.activeSchedule
			? `${data.activeSchedule.name} · ${data.activeSchedule.startHour}–${data.activeSchedule.endHour}h`
			: 'Open deck · your hand-picked clusters'
	);

	async function playVibe() {
		const { ok, data: json } = await post<{ tracks?: unknown[] }>('/api/play-vibe', {
			clusterIds: data.vibeClusterIds
		});
		if (ok) toastStore.show(`Playing vibe (${(json.tracks ?? []).length} tracks)`);
	}

	async function playScheduled() {
		const { ok } = await post('/api/play-vibe', { useSchedule: true });
		if (ok) toastStore.show('Playing scheduled slot');
	}
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
				{slotLine}. {data.vibeClusterIds.length} clusters in rotation, {data.upNext.length} tracks
				coming up — one tap and the room wakes up.
			</p>
			<div class="mt-7 flex flex-wrap gap-2.5">
				<button
					class="rounded-full bg-accent px-7 py-3 font-bold text-cream shadow-lg shadow-accent/30 transition hover:-translate-y-0.5 hover:bg-accent-deep"
					onclick={playVibe}>▶ Play the vibe</button
				>
				<button
					class="rounded-full bg-ink px-6 py-3 font-bold text-cream transition hover:-translate-y-0.5 hover:bg-ink-soft"
					onclick={playScheduled}>Play scheduled slot</button
				>
			</div>
			<dl class="mt-8 flex flex-wrap gap-x-10 gap-y-3">
				<div>
					<dt class="text-[11px] font-bold tracking-[0.2em] text-faded uppercase">In rotation</dt>
					<dd class="font-display text-3xl font-black">{data.vibeClusterIds.length} <span class="text-base font-light italic text-faded">clusters</span></dd>
				</div>
				<div>
					<dt class="text-[11px] font-bold tracking-[0.2em] text-faded uppercase">Coming up</dt>
					<dd class="font-display text-3xl font-black">{data.upNext.length} <span class="text-base font-light italic text-faded">tracks</span></dd>
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
		<Player initial={data.player} />
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

<!-- SETLIST — the live booth queue, straight from Music Assistant -->
<section class="mt-6 animate-rise rounded-3xl border border-ink/15 bg-cream p-6 shadow-sm sm:p-7" style="animation-delay: 300ms">
	<div class="mb-2 flex flex-wrap items-baseline justify-between gap-2">
		<h2 class="font-display text-3xl font-black">Up next <span class="font-light text-faded italic">— the setlist</span></h2>
		<p class="text-xs font-bold tracking-[0.2em] text-faded uppercase">live from the booth</p>
	</div>
	{#if data.upNext.length === 0}
		<div class="rounded-2xl border border-dashed border-ink/20 bg-cream/60 px-6 py-8 text-center">
			<p class="text-sm text-faded">The booth queue is empty — nothing lined up after this track.</p>
			<button
				class="mt-4 rounded-full bg-accent px-6 py-2.5 font-bold text-cream shadow-lg shadow-accent/30 transition hover:-translate-y-0.5 hover:bg-accent-deep"
				onclick={playVibe}>▶ Play the vibe</button
			>
		</div>
	{:else}
		<TrackList tracks={data.upNext} />
	{/if}
</section>
