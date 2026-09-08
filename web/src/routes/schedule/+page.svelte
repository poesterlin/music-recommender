<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { toastStore } from '$lib/client/toast.svelte';
	import { api } from '$lib/api';
	import { clusterLabel, type VibeSchedule } from '$lib/clusters';

	let { data } = $props();

	let schedules = $state<VibeSchedule[]>(data.schedules);
	let activeSchedule = $state<VibeSchedule | null>(data.activeSchedule);

	let name = $state('');
	let startHour = $state(6);
	let endHour = $state(10);
	let clustersRaw = $state('');

	async function refresh() {
		const { ok, data: json } = await api<{
			schedules: VibeSchedule[];
			activeSchedule: VibeSchedule | null;
		}>('/api/vibe-schedules');
		if (ok) {
			schedules = json.schedules;
			activeSchedule = json.activeSchedule;
		}
	}

	async function create() {
		const clusterIds = clustersRaw.trim()
			? clustersRaw.split(',').map((x) => parseInt(x.trim())).filter((x) => Number.isInteger(x))
			: [];
		if (!name.trim()) {
			toastStore.show('Give the slot a name');
			return;
		}
		if (!clusterIds.length) {
			toastStore.show('Enter cluster ids (e.g. 2,10,16) — or pick them in the Vibe Mixer');
			return;
		}
		const { ok, data: json } = await api<{ error?: string }>('/api/vibe-schedules', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: name.trim(), startHour, endHour, clusterIds })
		});
		if (!ok) {
			toastStore.show('Failed: ' + (json.error ?? 'unknown'));
			return;
		}
		name = '';
		clustersRaw = '';
		await refresh();
		toastStore.show('Slot added');
	}

	async function toggle(id: number, enabled: boolean) {
		await api('/api/vibe-schedules', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ id, enabled })
		});
		await refresh();
	}

	async function remove(id: number) {
		if (!confirm('Delete this slot?')) return;
		await api(`/api/vibe-schedules?id=${id}`, { method: 'DELETE' });
		await refresh();
	}
</script>

<PageHeader
	title="Schedule"
	description="Time-of-day slots that pick your vibe automatically. Hour ranges are 0–24 and can wrap overnight (e.g. 22–6). Play a slot from the Vibe Mixer with “Play scheduled slot”."
/>

<section class="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
	<h2 class="text-lg font-bold text-gray-900">Slots</h2>
	{#if schedules.length === 0}
		<p class="mt-2 text-sm text-gray-400">No slots yet — add your first one below.</p>
	{:else}
		<div class="mt-4 space-y-2">
			{#each schedules as s (s.id)}
				<div
					class="flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 {activeSchedule?.id === s.id
						? 'border-green-300 bg-green-50'
						: 'border-gray-200 bg-gray-50'}"
				>
					<div class="min-w-40 flex-1">
						<p class="font-bold text-gray-900">
							{s.name}
							{#if activeSchedule?.id === s.id}<span class="ml-1 text-xs font-semibold text-green-600">● now</span>{/if}
						</p>
						<p class="text-sm text-gray-500">{s.startHour}–{s.endHour}h</p>
						<p class="mt-1 text-xs text-gray-500">{s.clusterIds.map(clusterLabel).join(', ')}</p>
					</div>
					<label class="flex items-center gap-2 text-sm text-gray-500">
						<input type="checkbox" class="size-4 accent-green-600" checked={s.enabled !== false} onchange={(e) => toggle(s.id, e.currentTarget.checked)} />
						On
					</label>
					<button class="rounded-lg bg-red-100 px-3 py-1.5 text-sm font-semibold text-red-700 hover:bg-red-200" onclick={() => remove(s.id)}>Delete</button>
				</div>
			{/each}
		</div>
	{/if}
</section>

<section class="mt-6 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
	<h2 class="text-lg font-bold text-gray-900">Add slot</h2>
	<div class="mt-4 grid max-w-2xl gap-3">
		<label class="grid gap-1 text-sm text-gray-600">
			Name
			<input class="rounded-xl border border-gray-300 px-3 py-2" placeholder="Morning" bind:value={name} />
		</label>
		<div class="grid grid-cols-2 gap-3">
			<label class="grid gap-1 text-sm text-gray-600">
				From (hour)
				<input class="rounded-xl border border-gray-300 px-3 py-2" type="number" min="0" max="24" bind:value={startHour} />
			</label>
			<label class="grid gap-1 text-sm text-gray-600">
				To (hour)
				<input class="rounded-xl border border-gray-300 px-3 py-2" type="number" min="0" max="24" bind:value={endHour} />
			</label>
		</div>
		<label class="grid gap-1 text-sm text-gray-600">
			Clusters (comma separated ids)
			<input class="rounded-xl border border-gray-300 px-3 py-2" placeholder="2,10,16" bind:value={clustersRaw} />
		</label>
		<div>
			<button class="rounded-xl bg-blue-600 px-5 py-2.5 font-semibold text-white hover:bg-blue-700" onclick={create}>Add slot</button>
		</div>
	</div>
</section>
