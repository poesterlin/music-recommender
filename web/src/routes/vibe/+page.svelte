<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { toastStore } from '$lib/client/toast.svelte';
	import { api, post } from '$lib/api';
	import { CLUSTER_NAMES, clusterLabel } from '$lib/clusters';

	let { data } = $props();

	let vibeSelection = $state(new Set<number>(data.vibeClusterIds));
	let saveStatus = $state('');
	let filter = $state('');

	const clusterIds = Object.keys(CLUSTER_NAMES).map(Number).sort((a, b) => a - b);

	const visibleIds = $derived(
		filter.trim()
			? clusterIds.filter((id) =>
					`${id} ${CLUSTER_NAMES[id] ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase())
				)
			: clusterIds
	);

	function toggle(id: number, on: boolean) {
		const next = new Set(vibeSelection);
		if (on) next.add(id);
		else next.delete(id);
		vibeSelection = next;
	}

	function setAll(on: boolean) {
		vibeSelection = on ? new Set(clusterIds) : new Set();
	}

	function loadSlot() {
		if (!data.activeSchedule) {
			toastStore.show('No schedule slot matches the current hour');
			return;
		}
		vibeSelection = new Set(data.activeSchedule.clusterIds);
	}

	const selection = $derived([...vibeSelection].sort((a, b) => a - b));

	async function save() {
		if (!selection.length) {
			toastStore.show('Pick at least one cluster');
			return;
		}
		saveStatus = 'Saving...';
		const { ok, data: json } = await post<{ clusterIds: number[] }>('/api/play-vibe', {
			clusterIds: selection,
			saveOnly: true
		});
		saveStatus = ok ? `Saved ${json.clusterIds.length} picks. They survive restarts.` : 'Save failed';
	}

	async function play() {
		if (!selection.length) {
			toastStore.show('Pick at least one cluster');
			return;
		}
		const { ok, data: json } = await post<{ tracks?: unknown[] }>('/api/play-vibe', {
			clusterIds: selection
		});
		if (ok) toastStore.show(`Playing vibe (${(json.tracks ?? []).length} tracks)`);
	}

	async function playScheduled() {
		const { ok } = await post('/api/play-vibe', { useSchedule: true });
		if (ok) toastStore.show('Playing scheduled slot');
	}
</script>

<PageHeader
	title="Vibe Mixer"
	description="Pick the clusters you're in the mood for. Saving persists your picks; playing generates a 50-track mix from liked songs in those clusters and starts playback."
/>

{#if data.activeSchedule}
	<p class="mb-4 rounded-2xl border border-green-200 bg-green-50 px-5 py-3 text-sm text-green-800">
		Current slot: <b>{data.activeSchedule.name}</b> ({data.activeSchedule.startHour}–{data.activeSchedule
			.endHour}h): {data.activeSchedule.clusterIds.map(clusterLabel).join(', ')}
	</p>
{/if}

<div class="mb-4 flex flex-wrap items-center gap-2">
	<button class="rounded-lg bg-gray-500 px-3 py-1.5 text-sm text-white hover:bg-gray-600" onclick={() => setAll(true)}>Select all</button>
	<button class="rounded-lg bg-gray-500 px-3 py-1.5 text-sm text-white hover:bg-gray-600" onclick={() => setAll(false)}>Clear</button>
	<button class="rounded-lg bg-gray-500 px-3 py-1.5 text-sm text-white hover:bg-gray-600" onclick={loadSlot}>Load current slot</button>
	<input
		class="min-w-48 flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm sm:max-w-64"
		placeholder="Filter vibes… (e.g. rock, 41)"
		bind:value={filter}
	/>
	<span class="ml-1 text-sm text-gray-500">{vibeSelection.size} picked</span>
</div>

<div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
	{#each visibleIds as id (id)}
		<label
			class="flex cursor-pointer items-center gap-3 rounded-2xl border bg-white px-4 py-3 shadow-sm transition-colors {vibeSelection.has(id)
				? 'border-green-400 bg-green-50'
				: 'border-gray-200 hover:border-gray-300'}"
		>
			<input type="checkbox" class="size-4 accent-green-600" checked={vibeSelection.has(id)} onchange={(e) => toggle(id, e.currentTarget.checked)} />
			<span class="text-sm"><b class="text-gray-400">#{id}</b> <span class="font-medium text-gray-800">{CLUSTER_NAMES[id]}</span></span>
		</label>
	{/each}
</div>

<div class="sticky bottom-4 mt-6 flex flex-wrap items-center gap-2 rounded-2xl border border-gray-200 bg-white/95 p-3 shadow-lg backdrop-blur">
	<button class="rounded-xl bg-gray-600 px-5 py-2.5 font-semibold text-white hover:bg-gray-700" onclick={save}>Save picks</button>
	<button class="rounded-xl bg-green-600 px-5 py-2.5 font-semibold text-white hover:bg-green-700" onclick={play}>Play vibe with selection</button>
	<button class="rounded-xl bg-cyan-600 px-5 py-2.5 font-semibold text-white hover:bg-cyan-700" onclick={playScheduled}>Play scheduled slot</button>
	{#if saveStatus}<span class="text-sm text-gray-500">{saveStatus}</span>{/if}
</div>
