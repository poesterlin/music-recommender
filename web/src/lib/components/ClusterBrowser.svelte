<script lang="ts">
	import TrackList from '$lib/components/TrackList.svelte';
	import ClusterAtlas from '$lib/components/ClusterAtlas.svelte';
	import ClusterTile from '$lib/components/ClusterTile.svelte';
	import ClusterNamePanel from '$lib/components/ClusterNamePanel.svelte';
	import { toastStore } from '$lib/client/toast.svelte';
	import { api, post } from '$lib/api';

	type PreviewTrack = { uri: string; name: string; artists: string[]; album: string };

	let {
		clusters,
		clusterNames,
		covers = {},
		trackCounts = {},
		namedIds = []
	}: {
		clusters: Array<{
			clusterId: number;
			uri: string | null;
			name: string | null;
			artists: string[];
			album: string;
		}>;
		clusterNames: Record<number, string>;
		covers?: Record<number, { primary: string | null; secondary: string | null }>;
		trackCounts?: Record<number, number>;
		namedIds?: number[];
	} = $props();

	let names = $state<Record<number, string>>({ ...clusterNames });
	let naming = $state<number | null>(null);
	let title = $state('');
	let tracks = $state<PreviewTrack[]>([]);
	let loading = $state(false);
	let playing = $state(false);

	const named = $derived(new Set(namedIds));

	function clusterName(clusterId: number): string {
		return names[clusterId] ?? `Cluster ${clusterId}`;
	}

	/** Preview a random sample without leaving the grid. */
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

	function applyName(clusterId: number, name: string) {
		names = { ...names, [clusterId]: name.trim() || `Cluster ${clusterId}` };
	}
</script>

<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
	{#each clusters as c (c.clusterId)}
		<ClusterTile
			clusterId={c.clusterId}
			name={clusterName(c.clusterId)}
			trackCount={trackCounts[c.clusterId] ?? null}
			covers={covers[c.clusterId] ?? { primary: null, secondary: null }}
			named={named.has(c.clusterId)}
			onselect={(id) => (naming = id)}
			onpreview={sample}
		/>
	{:else}
		<p class="text-faded col-span-full py-8 text-center text-sm">
			No clusters yet. Run the full tidy-up from Manage.
		</p>
	{/each}
</div>

{#if title}
	<section class="animate-rise mt-8">
		<div class="mb-3 flex flex-wrap items-center justify-between gap-3">
			<h2 class="font-display text-xl font-black">{title}</h2>
			{#if tracks.length > 0}
				<button
					class="bg-moss text-cream hover:bg-moss/90 inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-bold transition disabled:opacity-50"
					disabled={playing}
					onclick={playSample}
				>
					{playing ? 'Starting…' : `Play ${tracks.length} tracks`}
				</button>
			{/if}
		</div>
		{#if loading}
			<p class="text-faded text-sm">Picking tracks…</p>
		{:else}
			<TrackList {tracks} emptyText="No tracks in this cluster." />
		{/if}
	</section>
{/if}

<section class="mt-10">
	<h2 class="font-display mb-3 text-xl font-black">Atlas</h2>
	<ClusterAtlas />
</section>

{#if naming !== null}
	<ClusterNamePanel
		clusterId={naming}
		currentName={clusterName(naming)}
		onclose={() => (naming = null)}
		onnamed={applyName}
	/>
{/if}
