<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import TrackList from '$lib/components/TrackList.svelte';

	let { data } = $props();
</script>

<PageHeader
	title="Activity"
	description="The last 100 tracks added to the library by indexing — the freshest imports, newest first. (A full per-run import log is coming later.)"
/>

<section class="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
	<h2 class="mb-4 text-lg font-bold text-gray-900">Recently indexed · {data.tracks.length}</h2>
	<TrackList tracks={data.tracks} emptyText="No tracks indexed yet — run “Index library” from Manage." />
</section>
