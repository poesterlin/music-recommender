<script lang="ts">
	import { onMount } from 'svelte';
	import { post } from '$lib/api';
	import { toastStore } from '$lib/client/toast.svelte';
	import type { VibeSchedule } from '$lib/server/vibe-store';
	import { IconPlayerPlay } from '@tabler/icons-svelte';

	let {
		schedules,
		active,
		picks,
		names,
		timezone,
		onPlay
	}: {
		schedules: VibeSchedule[];
		active: VibeSchedule | null;
		picks: number[];
		names: Record<number, string>;
		timezone: string;
		onPlay: () => Promise<void>;
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

<section class="border-ink/15 bg-cream rounded-3xl border p-6 shadow-sm sm:p-8">
	<div class="flex flex-wrap items-start justify-between gap-4">
		<div>
			<p class="text-accent-deep text-xs font-bold tracking-[0.18em] uppercase">
				{selected
					? selected.id === current?.id
						? 'Current scheduled vibe'
						: 'Selected vibe'
					: 'Manual picks'}
			</p>
			<h1 class="font-display mt-2 text-4xl font-black sm:text-5xl">
				{selected?.name ?? 'Your picks'}
			</h1>
			<p class="text-ink-soft mt-2 text-sm font-bold">
				{selected ? hours(selected) : current ? 'Your saved mix' : 'No scheduled vibe right now'}
			</p>
		</div>
		<a
			href="/vibe?tab=schedule"
			class="text-accent-deep text-sm font-bold underline underline-offset-4">Edit schedule</a
		>
	</div>
	<div class="mt-5 flex flex-wrap gap-2">
		{#each ids as id (id)}
			<span class="bg-ink/5 text-ink-soft rounded-full px-3 py-1.5 text-sm"
				>{clusterNames[id] ?? `Cluster ${id}`}</span
			>
		{/each}
	</div>
	<div class="mt-6 flex flex-wrap items-center gap-4">
		<button
			onclick={() => play(selected)}
			disabled={busy || !ids.length}
			class="{playButtonClass} bg-accent text-cream hover:bg-accent-deep px-7"
		>
			<IconPlayerPlay size={18} class="shrink-0" />
			{busy && (!selected || !playingPicks) ? 'Starting…' : `Play ${selected?.name ?? 'my picks'}`}
		</button>
		{#if selected}
			<button
				class="{playButtonClass} border-ink/15 text-ink hover:bg-ink/5 border px-4 text-sm"
				disabled={busy || !manualIds.length}
				onclick={() => play(null)}
			>
				<IconPlayerPlay size={18} class="shrink-0" />
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
		<a
			href="/vibe?tab=browse"
			class="text-accent-deep inline-flex min-h-12 items-center text-sm font-bold underline underline-offset-4"
			>Browse vibes</a
		>
	</div>
	{#if next}<p class="text-ink-soft mt-3 text-sm">
			Next: <strong>{next.slot.name}</strong> at {time(next.slot.startHour)}{next.wait +
				minuteOfDay >=
			1440
				? ' tomorrow'
				: ''}
		</p>{/if}
	{#if slots.length}
		<div class="border-ink/10 mt-6 border-t pt-5">
			<p class="text-faded mb-3 text-xs font-bold">Day schedule · {zone}</p>
			<div class="grid gap-2 sm:grid-cols-3">
				{#each slots as slot (slot.id)}
					<button
						onclick={() => (selectedId = slot.id)}
						aria-pressed={selected?.id === slot.id}
						class="rounded-2xl border p-4 text-left transition {selected?.id === slot.id
							? 'border-accent bg-accent/10'
							: 'border-ink/10 hover:bg-ink/5'}"
					>
						<span class="block font-bold"
							>{slot.name}{slot.id === current?.id ? ' · Current' : ''}</span
						>
						<span class="text-ink-soft mt-1 block text-sm">{hours(slot)}</span>
					</button>
				{/each}
			</div>
		</div>
	{:else}
		<p class="text-ink-soft mt-5 text-sm">
			No enabled schedules. <a class="underline underline-offset-4" href="/vibe?tab=schedule"
				>Create a schedule</a
			>
		</p>
	{/if}
</section>
