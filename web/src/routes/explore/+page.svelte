<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import TrackList from '$lib/components/TrackList.svelte';
	import { toastStore } from '$lib/client/toast.svelte';
	import { api, post } from '$lib/api';
	import { CLUSTER_NAMES, clusterLabel } from '$lib/clusters';

	let { data } = $props();

	let title = $state('');
	let tracks = $state<{ uri: string; name: string; artists: string[]; album: string }[]>([]);
	let loading = $state(false);
	let playing = $state(false);

	async function sample(clusterId: number) {
		loading = true;
		playing = false;
		title = clusterLabel(clusterId);
		tracks = [];
		const { ok, data: json } = await api<{
			tracks: { uri: string; name: string; artists: string[]; album: string }[];
		}>(`/api/sample-cluster?clusterId=${clusterId}`);
		if (ok) tracks = json.tracks;
		loading = false;
	}

	async function playSample() {
		if (!tracks.length) return;
		playing = true;
		const { ok } = await post('/api/player', { uris: tracks.map((t) => t.uri) });
		playing = false;
		if (ok) toastStore.show(`Playing sample on the booth (${tracks.length} tracks)`);
	}
</script>

<PageHeader
	title="Explore"
	description="Every cluster is a vibe of its own. Open one for 30 random tracks, then play the sample on the booth to hear what it sounds like."
/>

<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
	{#each data.clusters as c (c.clusterId)}
		<button
			class="rounded-2xl border border-gray-200 bg-white p-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-blue-400 hover:shadow disabled:cursor-default disabled:opacity-60 disabled:hover:translate-y-0"
			disabled={!c.uri}
			onclick={() => sample(c.clusterId)}
		>
			<p class="text-xs font-medium text-gray-400">#{c.clusterId}</p>
			<p class="mt-0.5 font-bold text-blue-700">{CLUSTER_NAMES[c.clusterId] ?? 'Unknown Vibe'}</p>
			{#if c.name}
				<p class="mt-2 text-sm text-gray-600">{c.name}</p>
				<p class="text-xs text-gray-400 italic">{c.artists.join(', ')}</p>
			{:else}
				<p class="mt-2 text-sm text-gray-400 italic">No preview track indexed yet.</p>
			{/if}
		</button>
	{:else}
		<p class="text-sm text-gray-400">No clusters found — is the library indexed?</p>
	{/each}
</div>

{#if title}
	<section class="mt-8 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<h2 class="text-lg font-bold text-gray-900">{title}</h2>
			{#if tracks.length > 0}
				<button
					class="rounded-xl bg-green-600 px-5 py-2 font-semibold text-white hover:bg-green-700 disabled:opacity-50"
					disabled={playing}
					onclick={playSample}
				>
					{playing ? 'Starting…' : `▶ Play sample (${tracks.length})`}
				</button>
			{/if}
		</div>
		<div class="mt-4">
			{#if loading}
				<p class="text-sm text-gray-400">Picking 30 tracks...</p>
			{:else}
				<TrackList {tracks} emptyText="No tracks in this cluster." />
			{/if}
		</div>
	</section>
{/if}
