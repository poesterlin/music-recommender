<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import TrackList from '$lib/components/TrackList.svelte';
	import { toastStore } from '$lib/client/toast.svelte';
	import { api, post } from '$lib/api';

	type SeedTrack = { uri: string; name: string; artists: string[] };

	let query = $state('');
	let limit = $state(30);
	let suggestions = $state<SeedTrack[]>([]);
	let suggestOpen = $state(false);
	let seed = $state<SeedTrack | null>(null);
	let title = $state('');
	let tracks = $state<{ uri: string; name: string; artists: string[] }[]>([]);
	let loading = $state(false);
	let playing = $state(false);

	let suggestTimer: ReturnType<typeof setTimeout> | null = null;
	async function onQuery() {
		seed = null;
		if (suggestTimer) clearTimeout(suggestTimer);
		const q = query.trim();
		if (q.length < 2) {
			suggestions = [];
			suggestOpen = false;
			return;
		}
		suggestTimer = setTimeout(async () => {
			const { ok, data } = await api<{ tracks: SeedTrack[] }>(
				`/api/search?q=${encodeURIComponent(q)}`
			);
			if (ok) {
				suggestions = data.tracks.slice(0, 8);
				suggestOpen = suggestions.length > 0;
			}
		}, 300);
	}

	function pick(s: SeedTrack) {
		seed = s;
		query = `${s.name} — ${s.artists.join(', ')}`;
		suggestions = [];
		suggestOpen = false;
	}

	async function recommend() {
		if (!query.trim()) {
			toastStore.show('Type a track name first');
			return;
		}
		loading = true;
		playing = false;
		tracks = [];
		title = '';
		// Use the picked suggestion when there is one; otherwise fall back to
		// the top search hit so Enter still works.
		let chosen = seed;
		if (!chosen) {
			const { ok, data: search } = await api<{ tracks: SeedTrack[] }>(
				`/api/search?q=${encodeURIComponent(query.trim())}`
			);
			if (!ok || search.tracks.length === 0) {
				title = `No track found matching "${query.trim()}"`;
				loading = false;
				return;
			}
			chosen = search.tracks[0];
			seed = chosen;
		}
		title = `Recommendations for: ${chosen.name}`;
		const rec = await post<{ tracks: { uri: string; name: string; artists: string[] }[] }>(
			'/api/recommend',
			{ seedUris: [chosen.uri], limit }
		);
		if (rec.ok) tracks = rec.data.tracks;
		loading = false;
	}

	async function playMix() {
		if (!tracks.length) return;
		playing = true;
		const { ok } = await post('/api/player', { uris: tracks.map((t) => t.uri) });
		playing = false;
		if (ok) toastStore.show(`Playing mix on the booth (${tracks.length} tracks)`);
	}
</script>

<PageHeader
	title="Recommend"
	description="Start from one track you love and get a fresh mix of similar songs. Press play to hear it on the booth."
/>

<div class="flex max-w-2xl flex-wrap items-end gap-3 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
	<div class="relative grid flex-1 gap-1 text-sm text-gray-600">
		<label for="rec-track">Track name</label>
		<input
			id="rec-track"
			class="rounded-xl border border-gray-300 px-3 py-2"
			placeholder="e.g. Ocean Eyes"
			bind:value={query}
			oninput={onQuery}
			onkeydown={(e) => {
				if (e.key === 'Enter') {
					suggestOpen = false;
					recommend();
				}
				if (e.key === 'Escape') suggestOpen = false;
			}}
			autocomplete="off"
		/>
		{#if suggestOpen}
			<ul class="absolute top-full right-0 left-0 z-10 mt-1 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
				{#each suggestions as s (s.uri)}
					<li>
						<button
							class="block w-full truncate px-3 py-2 text-left hover:bg-gray-100"
							onclick={() => pick(s)}
						>
							<b>{s.name}</b> <span class="text-gray-500">{s.artists.join(', ')}</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
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
		<div class="flex flex-wrap items-center justify-between gap-3">
			{#if title}<h2 class="text-lg font-bold text-gray-900">{title}</h2>{/if}
			{#if tracks.length > 0}
				<button
					class="rounded-xl bg-green-600 px-5 py-2 font-semibold text-white hover:bg-green-700 disabled:opacity-50"
					disabled={playing}
					onclick={playMix}
				>
					{playing ? 'Starting…' : `▶ Play mix (${tracks.length})`}
				</button>
			{/if}
		</div>
		<div class="mt-4">
			{#if loading}
				<p class="text-sm text-gray-400">Generating your mix...</p>
			{:else}
				<TrackList {tracks} emptyText="No recommendations came back — try another track." />
			{/if}
		</div>
	</section>
{/if}
