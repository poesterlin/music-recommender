<script lang="ts">
	import { IconPlayerPlayFilled, IconSearch, IconX } from '@tabler/icons-svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import TrackList from '$lib/components/TrackList.svelte';
	import { toastStore } from '$lib/client/toast.svelte';
	import { api, post } from '$lib/api';

	type SeedTrack = { uri: string; name: string; artists: string[] };
	type ResultTrack = { uri: string; name: string; artists: string[]; album?: string };

	let query = $state('');
	let limit = $state(30);
	let suggestions = $state<SeedTrack[]>([]);
	let suggestOpen = $state(false);
	let seed = $state<SeedTrack | null>(null);
	let title = $state('');
	let tracks = $state<ResultTrack[]>([]);
	let loading = $state(false);
	let playing = $state(false);

	const LIMITS = [10, 20, 30, 50, 100];

	let suggestTimer: ReturnType<typeof setTimeout> | null = null;

	// Typing invalidates a previously picked seed; without this, "Ocean Eyes"
	// followed by edits still recommends the first pick.
	function clearSeed() {
		seed = null;
		title = '';
	}

	async function onQuery() {
		clearSeed();
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
		query = s.name;
		suggestions = [];
		suggestOpen = false;
	}

	function clearSeedField() {
		query = '';
		clearSeed();
		suggestions = [];
		suggestOpen = false;
	}

	async function recommend() {
		const q = query.trim();
		if (!q) {
			toastStore.show('Enter a track name');
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
				`/api/search?q=${encodeURIComponent(q)}`
			);
			if (!ok || search.tracks.length === 0) {
				title = `No track found matching “${q}”`;
				loading = false;
				return;
			}
			chosen = search.tracks[0];
			seed = chosen;
			query = chosen.name;
		}
		const rec = await post<{ tracks: ResultTrack[] }>('/api/recommend', {
			seedUris: [chosen.uri],
			limit
		});
		if (rec.ok) {
			tracks = rec.data.tracks;
			title = `Because you picked ${chosen.name}`;
		}
		loading = false;
	}

	async function playMix() {
		if (!tracks.length) return;
		playing = true;
		const { ok } = await post('/api/player', { uris: tracks.map((t) => t.uri) });
		playing = false;
		if (ok) toastStore.show(`Playing ${tracks.length} tracks`);
	}

	async function playOne(uri: string) {
		const { ok } = await post('/api/player', { uris: [uri] });
		if (ok) toastStore.show('Playing on the booth');
	}
</script>

<PageHeader
	title="Recommend"
	description="Start from one track and get tracks that sit close to it in the embedding space."
/>

<section class="border-ink/10 bg-cream/70 rounded-3xl border p-6 shadow-sm sm:p-8">
	<form
		class="grid gap-4"
		onsubmit={(e) => {
			e.preventDefault();
			suggestOpen = false;
			recommend();
		}}
	>
		<div class="grid gap-2">
			<label class="text-xs font-bold tracking-wide uppercase" for="rec-track">Seed track</label>
			<div class="relative">
				<IconSearch
					size={18}
					class="text-faded pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2"
				/>
				<input
					id="rec-track"
					class="border-ink/20 bg-paper focus:border-accent w-full rounded-xl border py-3 pr-10 pl-11 transition outline-none"
					placeholder="Track name, e.g. Ocean Eyes"
					bind:value={query}
					oninput={onQuery}
					onblur={() => setTimeout(() => (suggestOpen = false), 120)}
					onkeydown={(e) => e.key === 'Escape' && (suggestOpen = false)}
					autocomplete="off"
					role="combobox"
					aria-expanded={suggestOpen}
					aria-controls="rec-suggestions"
				/>
				{#if query}
					<button
						type="button"
						class="text-faded hover:text-ink absolute top-1/2 right-3 -translate-y-1/2"
						onclick={clearSeedField}
						aria-label="Clear"
					>
						<IconX size={16} />
					</button>
				{/if}
				{#if suggestOpen}
					<ul
						id="rec-suggestions"
						class="border-ink/15 bg-cream absolute top-full right-0 left-0 z-10 mt-2 overflow-hidden rounded-xl border shadow-lg"
					>
						{#each suggestions as s (s.uri)}
							<li>
								<button
									type="button"
									class="hover:bg-ink/5 flex w-full items-baseline gap-2 px-4 py-2.5 text-left transition"
									onmousedown={(e) => e.preventDefault()}
									onclick={() => pick(s)}
								>
									<span class="truncate font-bold">{s.name}</span>
									<span class="text-ink-soft shrink-0 truncate text-sm">{s.artists.join(', ')}</span
									>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			{#if seed}
				<p class="text-ink-soft text-sm">
					Seed: <b class="text-ink">{seed.name}</b> — {seed.artists.join(', ')}
				</p>
			{/if}
		</div>

		<div class="flex flex-wrap items-end justify-between gap-4">
			<div class="grid gap-2">
				<span class="text-xs font-bold tracking-wide uppercase">How many</span>
				<div class="flex flex-wrap gap-1.5">
					{#each LIMITS as option (option)}
						<button
							type="button"
							class="rounded-full px-3.5 py-1.5 text-sm font-bold transition {limit === option
								? 'bg-ink text-cream'
								: 'text-ink-soft hover:bg-ink/5 hover:text-ink'}"
							onclick={() => (limit = option)}
						>
							{option}
						</button>
					{/each}
				</div>
			</div>
			<button
				type="submit"
				class="bg-accent text-cream shadow-accent/20 hover:bg-accent-deep focus-visible:ring-accent/50 inline-flex items-center gap-2 rounded-xl px-6 py-3 font-bold shadow-md transition hover:shadow-lg focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
				disabled={loading}
			>
				{loading ? 'Finding…' : 'Recommend'}
			</button>
		</div>
	</form>
</section>

{#if title || loading}
	<section class="animate-rise mt-8">
		<div class="mb-4 flex flex-wrap items-center justify-between gap-3">
			<h2 class="font-display text-2xl font-black">{title || 'Recommendations'}</h2>
			{#if tracks.length > 0}
				<button
					class="bg-moss text-cream hover:bg-moss/90 inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition disabled:opacity-50"
					disabled={playing}
					onclick={playMix}
				>
					<IconPlayerPlayFilled size={15} />
					{playing ? 'Starting…' : `Play all ${tracks.length}`}
				</button>
			{/if}
		</div>
		{#if loading}
			<div
				class="border-ink/10 bg-cream/60 text-faded rounded-2xl border border-dashed px-6 py-10 text-center text-sm"
			>
				Finding similar tracks…
			</div>
		{:else}
			<TrackList
				{tracks}
				onPlay={playOne}
				emptyText="No recommendations came back. Try a different track."
			/>
		{/if}
	</section>
{/if}
