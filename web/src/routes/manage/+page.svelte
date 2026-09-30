<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { toastStore } from '$lib/client/toast.svelte';
	import { post } from '$lib/api';

	let { data } = $props();
	let embeddingMode = $state('medium');
	let sampleSeconds = $state(90);
	let settingsMessage = $state('');
	$effect(() => {
		embeddingMode = data.embeddingSettings.mode;
		sampleSeconds = data.embeddingSettings.maxSampleSeconds;
	});
	async function saveEmbeddingSettings() {
		const response = await fetch('/api/embedding-settings', {
			method: 'PUT', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ mode: embeddingMode, maxSampleSeconds: sampleSeconds })
		});
		const result = await response.json();
		settingsMessage = response.ok ? 'Saved. Workers use this recipe on their next run.' : result.error;
	}

	let artistName = $state('');
	let lidarrMsg = $state('');
	let lidarrOk = $state<boolean | null>(null);
	let running = $state<string | null>(null);
	let jobError = $state<string | null>(null);

	const JOBS = [
		{
			id: 'analyze',
			label: 'Full tidy-up',
			detail: 'Syncs and imports tracks; assigns embedded tracks when centroids exist.',
			path: '/api/analyze',
			confirm:
				'This syncs Music Assistant (can take 10+ min), then indexes and sorts new tracks. Start it?',
			scheduled: 'every 6h'
		},
		{
			id: 'index-library',
			label: 'Check for new music',
			detail: 'Indexes tracks added since the last run.',
			path: '/api/index-library',
			scheduled: 'on demand'
		},
		{
			id: 'sync-favorites',
			label: 'Refresh liked songs',
			detail: 'Re-imports your likes so mixes keep learning your taste.',
			path: '/api/sync-favorites',
			scheduled: 'hourly'
		}
	] as const;

	function lastRunLine(job: string): string {
		const run = data.lastRuns[job];
		if (!run) return 'Never run';
		const status = run.ok ? 'OK' : 'Failed';
		const source = run.source === 'automatic' ? 'scheduled' : 'manual';
		return `${status} · ${source} · ${run.when}`;
	}

	async function runJob(label: string, path: string, confirmText?: string) {
		if (confirmText && !confirm(confirmText)) return;
		running = label;
		jobError = null;
		const { ok, data: json } = await post<{
			error?: string;
			added?: number;
			existing?: number;
			fetched?: number;
			failed?: number;
			indexed?: number;
			assigned?: number;
		}>(path);
		running = null;
		if (ok) {
			// Report what changed, not how big the library is. A routine run
			// should read as "nothing new", not as a 52k-track import.
			const parts: string[] = [];
			if (json.added !== undefined) {
				parts.push(json.added > 0 ? `${json.added} new` : 'no new tracks');
			}
			if (json.indexed !== undefined) parts.push(`${json.indexed} indexed`);
			if (json.assigned !== undefined) parts.push(`${json.assigned} sorted`);
			toastStore.show(`${label} finished${parts.length ? ` (${parts.join(', ')})` : ''}`);
		} else {
			jobError = `${label}: ${json.error ?? 'Request failed. Check the connection settings.'}`;
		}
	}

	async function addArtist() {
		if (!artistName.trim()) {
			lidarrOk = false;
			lidarrMsg = 'Enter an artist name';
			return;
		}
		lidarrMsg = 'Adding…';
		lidarrOk = null;
		const { ok, data: json } = await post<{ success: boolean; message?: string }>(
			'/api/lidarr/add-artist',
			{ name: artistName.trim() }
		);
		lidarrOk = ok && json.success;
		lidarrMsg = json.message ?? (ok ? 'Done' : 'Failed');
		if (lidarrOk) artistName = '';
	}
</script>

<section class="mb-8 rounded-xl border p-6">
	<h2 class="font-display text-2xl">Embedding settings</h2>
	<p>Global recipe for all workers. Existing embeddings keep their recorded recipe.</p>
	<label>Mode
		<select bind:value={embeddingMode}>
			<option value="low">Low · 0.1s hop</option>
			<option value="medium">Medium · 0.5s hop</option>
			<option value="high">High · 1s hop</option>
		</select>
	</label>
	<label>Sample length (seconds) <input type="number" min="1" max="120" bind:value={sampleSeconds} /></label>
	<button onclick={saveEmbeddingSettings}>Save embedding settings</button>
	<p role="status">{settingsMessage}</p>
</section>

<PageHeader
	title="Manage"
	description="Keep the library current, add artists to Lidarr, and manage API access."
/>

<div class="mb-6 flex flex-wrap gap-2">
	<a
		class="border-ink/15 hover:bg-ink/5 rounded-xl border bg-white px-4 py-2 text-sm font-bold"
		href="/manage/duplicates"
	>
		Duplicates
	</a>
	<a
		class="border-ink/15 hover:bg-ink/5 rounded-xl border bg-white px-4 py-2 text-sm font-bold"
		href="/manage/access"
	>
		API keys
	</a>
	<a
		class="border-ink/15 hover:bg-ink/5 rounded-xl border bg-white px-4 py-2 text-sm font-bold"
		href="/status"
	>
		Worker status
	</a>
</div>

<section class="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
	<h2 class="text-lg font-bold text-gray-900">Library upkeep</h2>
	<p class="mb-4 text-sm text-gray-500">
		Automatic runs need the Compose job services. An initial embedding and clustering run is
		separate.
	</p>
	<div class="grid gap-3 lg:grid-cols-3">
		{#each JOBS as job (job.id)}
			<div class="flex flex-col rounded-xl border border-gray-200 p-4">
				<h3 class="font-semibold text-gray-900">{job.label}</h3>
				<p class="mt-1 flex-1 text-sm text-gray-500">{job.detail}</p>
				<p class="mt-3 text-xs text-gray-400">
					{job.scheduled === 'on demand' ? 'On demand' : `With jobs running: ${job.scheduled}`}
				</p>
				<p class="text-xs text-gray-500">{lastRunLine(job.id)}</p>
				<button
					class="mt-3 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
					disabled={running !== null || !data.musicAssistant}
					onclick={() => runJob(job.label, job.path, 'confirm' in job ? job.confirm : undefined)}
				>
					{running === job.label ? 'Running…' : 'Run now'}
				</button>
			</div>
		{/each}
	</div>
	{#if running}
		<p class="mt-3 text-sm text-gray-500">{running}… this may take a few minutes.</p>
	{/if}
	{#if !data.musicAssistant}<p class="mt-3 text-sm text-gray-600">
			Connect Music Assistant in <a class="font-bold underline" href="/setup">Setup</a> to run these jobs.
		</p>{/if}
	{#if jobError}<p class="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">
			{jobError}
		</p>{/if}
</section>

<section class="mt-6 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
	<h2 class="text-lg font-bold text-gray-900">Add to Lidarr</h2>
	<p class="mb-4 text-sm text-gray-500">
		Add an artist so new releases are fetched into your library.
	</p>
	<div class="flex flex-wrap gap-2">
		<input
			class="min-w-52 flex-1 rounded-xl border border-gray-300 px-3 py-2"
			placeholder="Artist name"
			bind:value={artistName}
			onkeydown={(e) => e.key === 'Enter' && addArtist()}
		/>
		<button
			class="rounded-xl bg-gray-600 px-5 py-2 font-semibold text-white hover:bg-gray-700"
			onclick={addArtist}
		>
			Add artist
		</button>
	</div>
	{#if lidarrMsg}
		<p class="mt-2 text-sm {lidarrOk ? 'text-green-600' : 'text-red-600'}">{lidarrMsg}</p>
	{/if}
</section>
