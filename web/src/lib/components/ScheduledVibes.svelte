<script lang="ts">
	import { onMount } from 'svelte';
	import { post } from '$lib/api';
	import { toastStore } from '$lib/client/toast.svelte';
	import type { VibeSchedule } from '$lib/server/vibe-store';
	import { IconPlayerPlay } from '@tabler/icons-svelte';
	import { coverUrl } from '$lib/cover-image';

	let {
		schedules,
		active,
		picks,
		names,
		timezone,
		onPlay,
		covers = {}
	}: {
		schedules: VibeSchedule[];
		active: VibeSchedule | null;
		picks: number[];
		names: Record<number, string>;
		timezone: string;
		onPlay: () => Promise<void>;
		covers?: Record<number, { primary: string | null; secondary: string | null }>;
	} = $props();

	let live = $state<{
		schedules: VibeSchedule[];
		activeSchedule: VibeSchedule | null;
		clusterIds: number[];
		names: Record<number, string>;
		scheduleTimezone: string;
	} | null>(null);
	let selectedId = $state<number | null>(null);
	let busy = $state(false);
	let playingPicks = $state(false);
	let now = $state(new Date());
	const playButtonClass =
		'inline-flex min-h-12 items-center justify-center gap-2 rounded-full py-3 font-bold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50';
	const slots = $derived(
		(live?.schedules ?? schedules)
			.filter((slot) => slot.enabled !== false && slot.clusterIds.length > 0)
			.toSorted((a, b) => a.startHour - b.startHour || a.id - b.id)
	);
	const current = $derived(live ? live.activeSchedule : active);
	const selected = $derived(
		selectedId === null ? current : (slots.find((slot) => slot.id === selectedId) ?? current)
	);
	const manualIds = $derived(live?.clusterIds ?? picks);
	const clusterNames = $derived(live?.names ?? names);
	const ids = $derived(selected?.clusterIds ?? manualIds);
	const zone = $derived(live?.scheduleTimezone ?? timezone);
	const minuteOfDay = $derived.by(() => {
		const parts = new Intl.DateTimeFormat('en-GB', {
			timeZone: zone,
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23'
		}).formatToParts(now);
		return (
			Number(parts.find((p) => p.type === 'hour')?.value) * 60 +
			Number(parts.find((p) => p.type === 'minute')?.value)
		);
	});
	const next = $derived(
		slots
			.filter((slot) => slot.id !== current?.id)
			.map((slot) => ({
				slot,
				wait: ((slot.startHour % 24) * 60 - minuteOfDay + 1440) % 1440 || 1440
			}))
			.toSorted((a, b) => a.wait - b.wait)[0]
	);

	function time(hour: number) {
		return `${String(hour).padStart(2, '0')}:00`;
	}
	function hours(slot: VibeSchedule) {
		return slot.startHour === slot.endHour
			? 'All day'
			: `${time(slot.startHour)}–${time(slot.endHour)}`;
	}
	async function refresh() {
		try {
			const response = await fetch('/api/play-vibe', { cache: 'no-store' });
			if (!response.ok) return;
			const result = await response.json();
			if (result.success) live = result;
		} catch {
			/* Keep the last schedule on a transient network failure. */
		}
	}
	async function play(chosen: VibeSchedule | null) {
		if (busy || !(chosen?.clusterIds ?? manualIds).length) return;
		playingPicks = chosen === null;
		busy = true;
		try {
			const { ok, data } = await post<{ tracks?: unknown[]; error?: string }>(
				'/api/play-vibe',
				chosen ? { scheduleId: chosen.id } : {}
			);
			if (ok) {
				toastStore.show(
					`Playing ${chosen?.name ?? 'your picks'} (${data.tracks?.length ?? 0} tracks)`
				);
				await onPlay();
			} else {
				toastStore.show(data.error ?? 'Could not start playback. Try again.');
			}
		} finally {
			busy = false;
		}
	}
	onMount(() => {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout>;
		async function tick() {
			now = new Date();
			if (!document.hidden) await refresh();
			if (!stopped) timer = setTimeout(tick, 60000 - (Date.now() % 60000));
		}
		const visible = () => {
			if (!document.hidden) {
				now = new Date();
				void refresh();
			}
		};
		void tick();
		document.addEventListener('visibilitychange', visible);
		return () => {
			stopped = true;
			clearTimeout(timer);
			document.removeEventListener('visibilitychange', visible);
		};
	});
</script>

<section
	id="mix"
	class="border-ink/10 bg-cream scroll-mt-24 rounded-[2rem] border p-6 shadow-[0_18px_40px_-28px_rgba(29,21,14,0.5)] sm:p-8 lg:p-10"
	aria-label="Mixes"
>
	<div class="grid gap-10 lg:grid-cols-[1.1fr_1fr] lg:gap-14">
		<div class="min-w-0">
			<div class="flex items-center gap-6">
				<div class="flex shrink-0 items-center pl-2" aria-hidden="true">
					{#each ids.slice(0, 3) as id, index (id)}
						{@const image = coverUrl(covers[id]?.primary ?? null, 256)}
						<div
							class="bg-ink ring-cream relative size-20 shrink-0 overflow-hidden rounded-lg shadow-lg ring-4 sm:size-24 {index >
							0
								? '-ml-9'
								: ''}"
							style="transform: rotate({index % 2 === 0 ? -5 : 4}deg); z-index: {3 - index}"
						>
							{#if image}<img src={image} alt="" class="size-full object-cover" />{:else}<div
									class="vinyl flex size-full items-center justify-center"
								>
									<span class="bg-accent border-ink size-6 rounded-full border-8"></span>
								</div>{/if}
						</div>
					{:else}
						<div class="vinyl size-20 rounded-full shadow-lg sm:size-24"></div>
					{/each}
				</div>
				<div class="min-w-0">
					<p class="text-accent-deep text-xs font-bold tracking-[0.2em] uppercase">
						{selected
							? selected.id === current?.id
								? 'On the dial now'
								: 'Selected mix'
							: 'Manual picks'}
					</p>
					<h2
						class="font-display mt-1.5 text-3xl leading-tight font-black text-balance sm:text-4xl"
					>
						{selected?.name ?? 'Your picks'}
					</h2>
					<p class="text-ink-soft mt-1 text-sm font-bold">
						{selected
							? hours(selected)
							: current
								? 'Your saved mix'
								: 'No scheduled vibe right now'}
					</p>
				</div>
			</div>

			<div class="mt-6 flex flex-wrap gap-2">
				{#each ids as id (id)}
					<span class="bg-ink/5 text-ink-soft rounded-full px-3 py-1.5 text-sm"
						>{clusterNames[id] ?? `Cluster ${id}`}</span
					>
				{/each}
			</div>

			<div class="mt-7 flex flex-wrap items-center gap-3">
				<button
					onclick={() => play(selected)}
					disabled={busy || !ids.length}
					class="{playButtonClass} bg-ink text-cream hover:bg-accent-deep px-7"
				>
					<IconPlayerPlay size={18} class="shrink-0" />
					{busy && (!selected || !playingPicks)
						? 'Starting…'
						: `Play ${selected?.name ?? 'my picks'}`}
				</button>
				{#if selected}
					<button
						class="{playButtonClass} border-ink/15 text-ink hover:bg-ink/5 border px-5 text-sm"
						disabled={busy || !manualIds.length}
						onclick={() => play(null)}
					>
						{busy && playingPicks ? 'Starting…' : 'Play my picks'}
					</button>
				{/if}
				{#if selectedId !== null}
					<button
						class="text-accent-deep min-h-12 cursor-pointer text-sm font-bold underline underline-offset-4 disabled:opacity-50"
						disabled={busy}
						onclick={() => (selectedId = null)}>Follow schedule</button
					>
				{/if}
			</div>
			{#if next}<p class="text-ink-soft mt-4 text-sm">
					Next up: <strong>{next.slot.name}</strong> at {time(next.slot.startHour)}{next.wait +
						minuteOfDay >=
					1440
						? ' tomorrow'
						: ''}
				</p>{/if}
		</div>

		<div class="min-w-0">
			<div class="mb-3 flex items-baseline justify-between gap-3">
				<p class="text-faded text-xs font-bold tracking-[0.2em] uppercase">Your day · {zone}</p>
				<a
					href="/vibe?tab=schedule"
					class="text-accent-deep text-sm font-bold underline underline-offset-4">Edit schedule</a
				>
			</div>
			{#if slots.length}
				<ul class="grid gap-2">
					{#each slots as slot (slot.id)}
						{@const isNow = slot.id === current?.id}
						<li>
							<button
								onclick={() => (selectedId = slot.id)}
								aria-pressed={selected?.id === slot.id}
								class="flex w-full cursor-pointer items-center gap-4 rounded-2xl border px-4 py-3 text-left transition {selected?.id ===
								slot.id
									? 'border-ink bg-ink text-cream'
									: 'border-ink/10 hover:bg-ink/5'}"
							>
								<span
									class="w-24 shrink-0 text-sm font-bold tabular-nums {selected?.id === slot.id
										? 'text-cream/60'
										: 'text-faded'}">{hours(slot)}</span
								>
								<span class="min-w-0 flex-1 truncate font-bold">{slot.name}</span>
								{#if isNow}
									<span
										class="bg-accent text-cream rounded-full px-2.5 py-0.5 text-[11px] font-bold tracking-wide uppercase"
										>Now</span
									>
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="text-ink-soft text-sm">
					No enabled schedules. <a class="underline underline-offset-4" href="/vibe?tab=schedule"
						>Create a schedule</a
					>
				</p>
			{/if}
		</div>
	</div>
</section>
