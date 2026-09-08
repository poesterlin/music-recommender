<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { toastStore } from '$lib/client/toast.svelte';
	import { api } from '$lib/api';
	import { CLUSTER_NAMES, clusterLabel, type VibeSchedule } from '$lib/clusters';

	let { data } = $props();

	let schedules = $state<VibeSchedule[]>(data.schedules);
	let activeSchedule = $state<VibeSchedule | null>(data.activeSchedule);

	let editingId = $state<number | null>(null);
	let name = $state('');
	let startHour = $state(6);
	let endHour = $state(10);
	let picked = $state(new Set<number>());

	const clusterIds = Object.keys(CLUSTER_NAMES).map(Number).sort((a, b) => a - b);

	function togglePick(id: number, on: boolean) {
		const next = new Set(picked);
		if (on) next.add(id);
		else next.delete(id);
		picked = next;
	}

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

	function resetForm() {
		editingId = null;
		name = '';
		startHour = 6;
		endHour = 10;
		picked = new Set();
	}

	function edit(s: VibeSchedule) {
		editingId = s.id;
		name = s.name;
		startHour = s.startHour;
		endHour = s.endHour;
		picked = new Set(s.clusterIds);
		document.getElementById('slot-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	async function save() {
		if (!name.trim()) {
			toastStore.show('Give the slot a name');
			return;
		}
		if (picked.size === 0) {
			toastStore.show('Pick at least one vibe below');
			return;
		}
		const payload = {
			name: name.trim(),
			startHour: Number(startHour),
			endHour: Number(endHour),
			clusterIds: [...picked].sort((a, b) => a - b)
		};
		if (editingId === null) {
			const { ok, data: json } = await api<{ error?: string }>('/api/vibe-schedules', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			if (!ok) {
				toastStore.show('Failed: ' + (json.error ?? 'unknown'));
				return;
			}
			toastStore.show('Slot added');
		} else {
			const { ok, data: json } = await api<{ error?: string }>('/api/vibe-schedules', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id: editingId, ...payload })
			});
			if (!ok) {
				toastStore.show('Failed: ' + (json.error ?? 'unknown'));
				return;
			}
			toastStore.show('Slot updated');
		}
		resetForm();
		await refresh();
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
		if (editingId === id) resetForm();
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
					<button class="rounded-lg bg-gray-100 px-3 py-1.5 text-sm font-semibold text-gray-700 hover:bg-gray-200" onclick={() => edit(s)}>Edit</button>
					<button class="rounded-lg bg-red-100 px-3 py-1.5 text-sm font-semibold text-red-700 hover:bg-red-200" onclick={() => remove(s.id)}>Delete</button>
				</div>
			{/each}
		</div>
	{/if}
</section>

<section id="slot-form" class="mt-6 scroll-mt-24 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
	<h2 class="text-lg font-bold text-gray-900">{editingId === null ? 'Add slot' : `Edit slot: ${name}`}</h2>
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
		<div class="grid gap-1 text-sm text-gray-600">
			<span>Vibes in this slot ({picked.size} picked)</span>
			<div class="grid max-h-64 grid-cols-1 gap-1.5 overflow-y-auto rounded-xl border border-gray-200 p-2 sm:grid-cols-2">
				{#each clusterIds as id (id)}
					<label class="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-gray-50 {picked.has(id) ? 'bg-green-50 font-semibold' : ''}">
						<input type="checkbox" class="size-4 shrink-0 accent-green-600" checked={picked.has(id)} onchange={(e) => togglePick(id, e.currentTarget.checked)} />
						<span class="truncate"><b class="font-normal text-gray-400">#{id}</b> {CLUSTER_NAMES[id]}</span>
					</label>
				{/each}
			</div>
		</div>
		<div class="flex flex-wrap gap-2">
			<button class="rounded-xl bg-blue-600 px-5 py-2.5 font-semibold text-white hover:bg-blue-700" onclick={save}>
				{editingId === null ? 'Add slot' : 'Save changes'}
			</button>
			{#if editingId !== null}
				<button class="rounded-xl bg-gray-200 px-5 py-2.5 font-semibold text-gray-700 hover:bg-gray-300" onclick={resetForm}>Cancel</button>
			{/if}
		</div>
	</div>
</section>
