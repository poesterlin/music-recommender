<script lang="ts">
	import TrackList from '$lib/components/TrackList.svelte';
	import { toastStore } from '$lib/client/toast.svelte';
	import { api, post } from '$lib/api';
	import ClusterAtlas from '$lib/components/ClusterAtlas.svelte';

	type PreviewTrack = { uri: string; name: string; artists: string[]; album: string };

	let {
		clusters,
		clusterNames
	}: {
		clusters: Array<{
			clusterId: number;
			uri: string | null;
			name: string | null;
			artists: string[];
			album: string;
		}>;
		clusterNames: Record<number, string>;
	} = $props();

	let title = $state('');
	let tracks = $state<PreviewTrack[]>([]);
	let loading = $state(false);
	let playing = $state(false);

	function clusterName(clusterId: number): string {
		return clusterNames[clusterId] ?? `Cluster ${clusterId}`;
	}

	async function sample(clusterId: number) {
		loading = true;
		playing = false;
		title = `#${clusterId} ${clusterName(clusterId)}`;
		tracks = [];
		const { ok, data: json } = await api<{ tracks: PreviewTrack[] }>(
			`/api/sample-cluster?clusterId=${clusterId}`
		);
		if (ok) tracks = json.tracks;
		loading = false;
	}

	async function playSample() {
		if (!tracks.length) return;
		playing = true;
		const { ok } = await post('/api/player', { uris: tracks.map((t) => t.uri) });
		playing = false;
		if (ok) toastStore.show(`Playing ${tracks.length} tracks`);
	}
</script>

<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
	{#each clusters as c (c.clusterId)}
		<button
			class="rounded-2xl border border-gray-200 bg-white p-5 text-left shadow-sm transition hover:border-blue-400 hover:shadow disabled:opacity-60"
			disabled={!c.uri}
			onclick={() => sample(c.clusterId)}
		>
			<p class="text-xs font-medium text-gray-400">#{c.clusterId}</p>
			<p class="mt-0.5 font-bold text-blue-700">{clusterName(c.clusterId)}</p>
			{#if c.name}
				<p class="mt-2 truncate text-sm text-gray-600">{c.name}</p>
				<p class="truncate text-xs text-gray-400 italic">{c.artists.join(', ')}</p>
			{:else}
				<p class="mt-2 text-sm text-gray-400 italic">No tracks indexed yet.</p>
			{/if}
		</button>
	{:else}
		<p class="text-sm text-gray-400">No clusters yet — run the full tidy-up.</p>
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
					{playing ? 'Starting…' : `Play ${tracks.length} tracks`}
				</button>
			{/if}
		</div>
		<div class="mt-4">
			{#if loading}
				<p class="text-sm text-gray-400">Picking tracks…</p>
			{:else}
				<TrackList {tracks} emptyText="No tracks in this cluster." />
			{/if}
		</div>
	</section>
{/if}

<section class="mt-8">
	<h2 class="mb-3 text-lg font-bold text-gray-900">Atlas</h2>
	<ClusterAtlas />
</section>
