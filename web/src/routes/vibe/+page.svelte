<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import ClusterBrowser from '$lib/components/ClusterBrowser.svelte';
	import VibeScheduleEditor from '$lib/components/VibeScheduleEditor.svelte';
	import { toastStore } from '$lib/client/toast.svelte';
	import { post } from '$lib/api';
	import { type VibeSchedule } from '$lib/clusters';

	let { data } = $props();

	type Tab = 'mix' | 'browse' | 'schedule';
	let tab = $state<Tab>('mix');

	let vibeSelection = new SvelteSet<number>(data.vibeClusterIds);
	let schedules = $state<VibeSchedule[]>(data.vibeSchedules);
	let activeSchedule = $state<VibeSchedule | null>(data.activeSchedule);
	let saveStatus = $state('');
	let filter = $state('');

	const clusterIds = data.availableClusterIds;

	const TABS: Array<{ id: Tab; label: string }> = [
		{ id: 'mix', label: 'Mix' },
		{ id: 'browse', label: 'Browse' },
		{ id: 'schedule', label: 'Schedule' }
	];

	function clusterName(id: number): string {
		return data.clusterNames[id] ?? `Cluster ${id}`;
	}

	function clusterLabel(id: number): string {
		return `#${id} ${clusterName(id)}`;
	}

	const visibleIds = $derived(
		filter.trim()
			? clusterIds.filter((id) =>
					`${id} ${clusterName(id)}`.toLowerCase().includes(filter.trim().toLowerCase())
				)
			: clusterIds
	);

	function toggle(id: number, on: boolean) {
		if (on) vibeSelection.add(id);
		else vibeSelection.delete(id);
	}

	function setAll(on: boolean) {
		vibeSelection = on ? new SvelteSet(clusterIds) : new SvelteSet<number>();
	}

	function loadSlot() {
		if (!activeSchedule) {
			toastStore.show('No slot matches the current hour');
			return;
		}
		vibeSelection = new SvelteSet(activeSchedule.clusterIds);
		tab = 'mix';
	}

	function useSlot(slot: VibeSchedule) {
		vibeSelection = new SvelteSet(slot.clusterIds);
		tab = 'mix';
		toastStore.show(`Loaded ${slot.name}`);
	}

	const selection = $derived([...vibeSelection].sort((a, b) => a - b));

	async function save() {
		if (!selection.length) {
			toastStore.show('Pick at least one cluster');
			return;
		}
		saveStatus = 'Saving…';
		const { ok, data: json } = await post<{ clusterIds: number[] }>('/api/play-vibe', {
			clusterIds: selection,
			saveOnly: true
		});
		saveStatus = ok ? `Saved ${json.clusterIds.length} picks` : 'Save failed';
	}

	async function play() {
		if (!selection.length) {
			toastStore.show('Pick at least one cluster');
			return;
		}
		const { ok, data: json } = await post<{ tracks?: unknown[] }>('/api/play-vibe', {
			clusterIds: selection
		});
		if (ok) toastStore.show(`Playing ${(json.tracks ?? []).length} tracks`);
	}

	async function playScheduled() {
		if (!activeSchedule) {
			toastStore.show('No slot matches the current hour');
			return;
		}
		const { ok } = await post('/api/play-vibe', { useSchedule: true });
		if (ok) toastStore.show(`Playing ${activeSchedule.name}`);
	}
</script>

<PageHeader
	title="Vibe"
	description="Pick clusters, browse what they contain, or schedule them by time of day."
/>

<nav class="border-line mb-6 flex gap-1 border-b" aria-label="Vibe views">
	{#each TABS as t (t.id)}
		<button
			class="-mb-px border-b-2 px-4 py-2 text-sm font-bold transition {tab === t.id
				? 'border-accent text-ink'
				: 'text-ink-soft hover:text-ink border-transparent'}"
			aria-current={tab === t.id ? 'page' : undefined}
			onclick={() => (tab = t.id)}
		>
			{t.label}
		</button>
	{/each}
</nav>

{#if tab === 'mix'}
	{#if activeSchedule}
		<p
			class="mb-4 rounded-2xl border border-green-200 bg-green-50 px-5 py-3 text-sm text-green-800"
		>
			Current slot: <b>{activeSchedule.name}</b>
			({activeSchedule.startHour}–{activeSchedule.endHour}h):
			{activeSchedule.clusterIds.map(clusterLabel).join(', ')}
		</p>
	{/if}

	<div class="mb-4 flex flex-wrap items-center gap-2">
		<button
			class="rounded-lg bg-gray-500 px-3 py-1.5 text-sm text-white hover:bg-gray-600"
			onclick={() => setAll(true)}>Select all</button
		>
		<button
			class="rounded-lg bg-gray-500 px-3 py-1.5 text-sm text-white hover:bg-gray-600"
			onclick={() => setAll(false)}>Clear</button
		>
		<button
			class="rounded-lg bg-gray-500 px-3 py-1.5 text-sm text-white hover:bg-gray-600"
			onclick={loadSlot}>Load current slot</button
		>
		<input
			class="min-w-48 flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm sm:max-w-64"
			placeholder="Filter clusters…"
			bind:value={filter}
		/>
		<span class="ml-1 text-sm text-gray-500">{vibeSelection.size} picked</span>
	</div>

	<div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
		{#each visibleIds as id (id)}
			<label
				class="flex cursor-pointer items-center gap-3 rounded-2xl border bg-white px-4 py-3 shadow-sm transition-colors {vibeSelection.has(
					id
				)
					? 'border-green-400 bg-green-50'
					: 'border-gray-200 hover:border-gray-300'}"
			>
				<input
					type="checkbox"
					class="size-4 accent-green-600"
					checked={vibeSelection.has(id)}
					onchange={(e) => toggle(id, e.currentTarget.checked)}
				/>
				<span class="text-sm"
					><b class="text-gray-400">#{id}</b>
					<span class="font-medium text-gray-800">{clusterName(id)}</span></span
				>
			</label>
		{/each}
	</div>

	<div
		class="sticky bottom-4 mt-6 flex flex-wrap items-center gap-2 rounded-2xl border border-gray-200 bg-white/95 p-3 shadow-lg backdrop-blur"
	>
		<button
			class="rounded-xl bg-gray-600 px-5 py-2.5 font-semibold text-white hover:bg-gray-700"
			onclick={save}>Save picks</button
		>
		<button
			class="rounded-xl bg-green-600 px-5 py-2.5 font-semibold text-white hover:bg-green-700"
			onclick={play}>Play selection</button
		>
		{#if activeSchedule}
			<button
				class="rounded-xl bg-cyan-600 px-5 py-2.5 font-semibold text-white hover:bg-cyan-700"
				onclick={playScheduled}>Play {activeSchedule.name}</button
			>
		{/if}
		{#if saveStatus}<span class="text-sm text-gray-500">{saveStatus}</span>{/if}
	</div>
{:else if tab === 'browse'}
	<ClusterBrowser
		clusters={data.clusters}
		clusterNames={data.clusterNames}
		covers={data.covers}
		trackCounts={data.trackCounts}
		namedIds={data.namedIds}
	/>
{:else}
	<VibeScheduleEditor
		bind:schedules
		bind:activeSchedule
		{clusterIds}
		clusterNames={data.clusterNames}
		onUseSlot={useSlot}
	/>
{/if}
