<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import TrackList from '$lib/components/TrackList.svelte';
	import { toastStore } from '$lib/client/toast.svelte';
	import { api, post } from '$lib/api';

	let query = $state('');
	let limit = $state(30);
	let title = $state('');
	let tracks = $state<{ uri: string; name: string; artists: string[] }[]>([]);
	let loading = $state(false);

	async function recommend() {
		if (!query.trim()) {
			toastStore.show('Type a track name first');
			return;
		}
		loading = true;
		tracks = [];
		title = '';
		const { ok, data: search } = await api<{
			tracks: { uri: string; name: string; artists: string[] }[];
		}>(`/api/search?q=${encodeURIComponent(query.trim())}`);
		if (!ok || search.tracks.length === 0) {
			title = `No track found matching "${query.trim()}"`;
			loading = false;
			return;
		}
		const seed = search.tracks[0];
		title = `Recommendations for: ${seed.name}`;
		const rec = await post<{ tracks: { uri: string; name: string; artists: string[] }[] }>(
			'/api/recommend',
			{ seedUris: [seed.uri], limit }
		);
		if (rec.ok) tracks = rec.data.tracks;
		loading = false;
	}
</script>

<PageHeader
	title="Recommend"
	description="Start from one track you love and get a fresh mix of similar songs. The mix is also saved as your current queue."
/>

<div class="flex max-w-2xl flex-wrap items-end gap-3 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
	<label class="grid flex-1 gap-1 text-sm text-gray-600">
		Track name
		<input
			class="rounded-xl border border-gray-300 px-3 py-2"
			placeholder="e.g. Ocean Eyes"
			bind:value={query}
			onkeydown={(e) => e.key === 'Enter' && recommend()}
		/>
	</label>
	<label class="grid gap-1 text-sm text-gray-600">
		Count
		<input class="w-24 rounded-xl border border-gray-300 px-3 py-2" type="number" min="5" max="100" bind:value={limit} />
	</label>
	<button class="rounded-xl bg-blue-600 px-5 py-2.5 font-semibold text-white hover:bg-blue-700" onclick={recommend}>
		Get recommendations
	</button>
</div>

{#if title || loading}
	<section class="mt-6 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
		{#if title}<h2 class="mb-4 text-lg font-bold text-gray-900">{title}</h2>{/if}
		{#if loading}
			<p class="text-sm text-gray-400">Generating your mix...</p>
		{:else}
			<TrackList {tracks} emptyText="No recommendations came back — try another track." />
		{/if}
	</section>
{/if}
