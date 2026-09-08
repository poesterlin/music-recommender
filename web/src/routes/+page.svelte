<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Player from '$lib/components/Player.svelte';
	import TrackList from '$lib/components/TrackList.svelte';
	import { toastStore } from '$lib/client/toast.svelte';
	import { post } from '$lib/api';
	import { CLUSTER_NAMES, clusterLabel } from '$lib/clusters';

	let { data } = $props();

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

	async function playQueue() {
		const { ok } = await post('/music/play');
		if (ok) toastStore.show('Queue playing');
	}
</script>

<PageHeader
	title="Home"
	description="Your music at a glance: what's playing, which vibe is active, and one-tap playback."
/>

<div class="grid gap-6 lg:grid-cols-2">
	<Player initial={data.player} />

	<section class="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
		<h2 class="text-sm font-semibold tracking-wide text-gray-400 uppercase">Active vibe</h2>
		{#if data.activeSchedule}
			<p class="mt-2 text-2xl font-bold text-gray-900">{data.activeSchedule.name}</p>
			<p class="mt-1 text-sm text-gray-500">
				{data.activeSchedule.startHour}–{data.activeSchedule.endHour}h · {data.activeSchedule
					.clusterIds.length} clusters
			</p>
			<p class="mt-3 text-sm leading-relaxed text-gray-600">
				{data.activeSchedule.clusterIds.map(clusterLabel).join(', ')}
			</p>
		{:else}
			<p class="mt-2 text-2xl font-bold text-gray-900">{data.vibeClusterIds.length} clusters picked</p>
			<p class="mt-1 text-sm text-gray-500">No schedule slot matches the current hour — manual picks apply.</p>
			<p class="mt-3 text-sm leading-relaxed text-gray-600">
				{data.vibeClusterIds.map(clusterLabel).join(', ')}
			</p>
		{/if}
		<div class="mt-5 flex flex-wrap gap-2">
			<button class="rounded-xl bg-green-600 px-5 py-2.5 font-semibold text-white hover:bg-green-700" onclick={playVibe}>Play vibe</button>
			<button class="rounded-xl bg-cyan-600 px-5 py-2.5 font-semibold text-white hover:bg-cyan-700" onclick={playScheduled}>Play scheduled slot</button>
			<button class="rounded-xl bg-blue-600 px-5 py-2.5 font-semibold text-white hover:bg-blue-700" onclick={playQueue}>Play queue</button>
		</div>
	</section>
</div>

<section class="mt-6 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
	<h2 class="text-lg font-bold text-gray-900">Up next</h2>
	<p class="mb-4 text-sm text-gray-500">Tracks queued by the last recommendation run.</p>
	<TrackList tracks={data.queue} emptyText="Queue is empty — play a vibe to fill it." />
</section>
