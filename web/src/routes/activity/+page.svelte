<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import TrackList from '$lib/components/TrackList.svelte';
	import { toastStore } from '$lib/client/toast.svelte';
	import { post } from '$lib/api';

	let { data } = $props();

	function fmtDate(iso: string | null): string {
		if (!iso) return '';
		const d = new Date(iso);
		if (isNaN(d.getTime())) return '';
		return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
	}

	const tracks = $derived(
		(data.tracks as { uri: string; name: string; artists: string[]; album: string; createdAt: string | null }[]).map(
			(t) => ({ ...t, note: t.createdAt ? `Indexed ${fmtDate(t.createdAt)}` : '' })
		)
	);

	async function playTrack(uri: string) {
		const { ok } = await post('/api/player', { uris: [uri] });
		if (ok) toastStore.show('Playing on the booth');
	}
</script>

<PageHeader
	title="Activity"
	description="The last 100 tracks added to the library by indexing — the freshest imports, newest first."
/>

<section class="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
	<h2 class="mb-4 text-lg font-bold text-gray-900">Recently indexed · {tracks.length}</h2>
	<TrackList {tracks} onPlay={playTrack} emptyText="No tracks indexed yet — run “Index library” from Manage." />
</section>
