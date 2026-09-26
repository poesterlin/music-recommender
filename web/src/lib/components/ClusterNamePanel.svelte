<script lang="ts">
	import { IconCheck, IconPlayerPlayFilled, IconX } from '@tabler/icons-svelte';
	import TrackList from '$lib/components/TrackList.svelte';
	import { coverUrl } from '$lib/cover-image';
	import { toastStore } from '$lib/client/toast.svelte';
	import { api, post } from '$lib/api';

	type Evidence = {
		clusterId: number;
		trackCount: number;
		artists: Array<{ name: string; count: number }>;
		tracks: Array<{
			name: string;
			artists: string[];
			albumImage: string | null;
			similarity: number;
		}>;
	};

	let {
		clusterId,
		currentName,
		onclose,
		onnamed
	}: {
		clusterId: number;
		currentName: string;
		onclose: () => void;
		onnamed: (clusterId: number, name: string) => void;
	} = $props();

	let evidence = $state<Evidence | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let playing = $state(false);
	let draft = $state(currentName);
	let named = $state(false);

	$effect(() => {
		const id = clusterId;
		named = false;
		loading = true;
		void (async () => {
			const { ok, data } = await api<{
				evidence: Evidence;
				displayName: string | null;
				humanNamed: boolean;
			}>(`/api/clusters/${id}/evidence`);
			evidence = ok ? data.evidence : null;
			// Only prefill from a name a person actually chose; a carried-over
			// legacy name would silently become the new label on save.
			draft = (ok && data.humanNamed && data.displayName?.trim()) || currentName;
			named = ok ? data.humanNamed : false;
			loading = false;
		})();
	});

	const trackRows = $derived(
		(evidence?.tracks ?? []).map((t) => ({
			uri: null as string | null,
			name: t.name,
			artists: t.artists,
			note: `centrality ${t.similarity.toFixed(3)}`
		}))
	);

	async function save() {
		const name = draft.trim();
		if (!name) {
			toastStore.show('Enter a name');
			return;
		}
		saving = true;
		// api() already surfaces the server's error message via a toast.
		const { ok } = await api(`/api/clusters/${clusterId}/name`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name })
		});
		saving = false;
		if (ok) {
			named = true;
			onnamed(clusterId, name);
			toastStore.show(`Cluster #${clusterId} named`);
		}
	}

	async function clear() {
		saving = true;
		const { ok } = await api(`/api/clusters/${clusterId}/name`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: null })
		});
		saving = false;
		if (ok) {
			named = false;
			onnamed(clusterId, '');
			toastStore.show(`Cluster #${clusterId} reset`);
		}
	}

	async function playSample() {
		if (playing) return;
		playing = true;
		const { ok, data } = await api<{ tracks: Array<{ uri: string }> }>(
			`/api/sample-cluster?clusterId=${clusterId}`
		);
		if (ok && data.tracks.length) {
			const played = await post('/api/player', { uris: data.tracks.map((t) => t.uri) });
			if (played.ok) toastStore.show(`Playing ${data.tracks.length} tracks`);
		}
		playing = false;
	}
</script>

<div
	class="border-ink/10 bg-cream fixed inset-0 z-50 flex justify-end backdrop-blur-sm"
	role="presentation"
	onclick={(e) => e.currentTarget === e.target && onclose()}
>
	<aside
		class="border-ink/10 flex h-full w-full max-w-lg flex-col overflow-y-auto border-l shadow-2xl"
		aria-label="Cluster naming"
	>
		<header class="border-ink/10 bg-cream/95 sticky top-0 z-10 border-b px-6 py-4 backdrop-blur">
			<div class="flex items-start justify-between gap-3">
				<div>
					<p class="text-faded font-mono text-xs">cluster #{clusterId}</p>
					<h2 class="font-display text-xl font-black">Name this cluster</h2>
				</div>
				<button
					type="button"
					class="text-faded hover:text-ink hover:bg-ink/5 -mr-2 rounded-full p-2 transition"
					onclick={onclose}
					aria-label="Close"
				>
					<IconX size={18} />
				</button>
			</div>
		</header>

		<div class="flex-1 space-y-6 px-6 py-5">
			<div>
				<label class="text-xs font-bold tracking-wide uppercase" for="cluster-name">Name</label>
				<input
					id="cluster-name"
					class="border-ink/20 bg-paper focus:border-accent mt-2 w-full rounded-xl border px-3 py-2.5 transition outline-none"
					placeholder="e.g. Driving dancefloor electronica"
					bind:value={draft}
					onkeydown={(e) => e.key === 'Enter' && save()}
					maxlength="120"
				/>
				<div class="mt-2 flex items-center gap-2">
					<button
						type="button"
						class="bg-accent text-cream hover:bg-accent-deep inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-bold transition disabled:opacity-50"
						disabled={saving}
						onclick={save}
					>
						<IconCheck size={15} />
						{saving ? 'Saving…' : 'Save'}
					</button>
					{#if named}
						<button
							type="button"
							class="text-ink-soft hover:bg-ink/5 rounded-lg px-3 py-2 text-sm font-bold transition"
							disabled={saving}
							onclick={clear}
						>
							Reset
						</button>
						<span class="text-faded text-xs">named in this run</span>
					{:else}
						<span class="text-faded text-xs">not named yet</span>
					{/if}
				</div>
			</div>

			<div>
				<h3 class="text-xs font-bold tracking-wide uppercase">Evidence</h3>
				{#if loading}
					<p class="text-faded mt-2 text-sm">Loading the most central tracks…</p>
				{:else if !evidence}
					<p class="text-faded mt-2 text-sm">No embedded tracks in this cluster yet.</p>
				{:else}
					<p class="text-ink-soft mt-2 text-sm">
						{new Intl.NumberFormat().format(evidence.trackCount)} tracks. These are closest to the centroid,
						so they are what the cluster actually sounds like.
					</p>

					{#if evidence.artists.length > 0}
						<div class="mt-4">
							<p class="text-faded text-xs font-bold tracking-wide uppercase">
								Most common artists
							</p>
							<div class="mt-2 flex flex-wrap gap-1.5">
								{#each evidence.artists as artist (artist.name)}
									<span class="bg-ink/5 text-ink-soft rounded-full px-2.5 py-1 text-xs">
										{artist.name}
										<span class="text-faded tabular-nums">{artist.count}</span>
									</span>
								{/each}
							</div>
						</div>
					{/if}

					<div class="mt-5">
						<TrackList tracks={trackRows} emptyText="No central tracks found." />
					</div>

					{#if evidence.tracks.some((t) => t.albumImage)}
						<div class="mt-5">
							<p class="text-faded text-xs font-bold tracking-wide uppercase">Covers</p>
							<div class="mt-2 flex flex-wrap gap-2">
								{#each evidence.tracks.filter((t) => t.albumImage) as t (t.name)}
									{@const src = coverUrl(t.albumImage, 160)}
									{#if src}
										<img
											{src}
											alt={t.name}
											loading="lazy"
											class="border-ink/10 size-16 rounded-lg border object-cover shadow-sm"
										/>
									{/if}
								{/each}
							</div>
						</div>
					{/if}

					<button
						type="button"
						class="bg-moss text-cream hover:bg-moss/90 mt-6 inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold transition disabled:opacity-50"
						disabled={playing}
						onclick={playSample}
					>
						<IconPlayerPlayFilled size={15} />
						{playing ? 'Starting…' : 'Play a sample'}
					</button>
				{/if}
			</div>
		</div>
	</aside>
</div>
