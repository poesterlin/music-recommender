<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { toastStore } from '$lib/client/toast.svelte';
	import { post } from '$lib/api';

	let { data } = $props();

	let artistName = $state('');
	let lidarrMsg = $state('');
	let lidarrOk = $state<boolean | null>(null);
	let running = $state<string | null>(null);

	function lastRunLine(job: string): string {
		const run = data.lastRuns[job];
		if (!run) return 'Never run from here yet.';
		const status = run.ok ? '✓' : '✗';
		return `${status} Last run ${run.when}${run.detail ? ` — ${run.detail}` : ''}`;
	}

	async function runJob(label: string, path: string, confirmText?: string) {
		if (confirmText && !confirm(confirmText)) return;
		running = label;
		const { ok, data: json } = await post<{ count?: number; indexed?: number; assigned?: number }>(path);
		running = null;
		if (ok) {
			const detail = [json.count, json.indexed, json.assigned].filter((n) => n !== undefined).join(' / ');
			toastStore.show(`${label} finished${detail ? ` (${detail})` : ''}`);
		}
	}

	async function addArtist() {
		if (!artistName.trim()) {
			lidarrOk = false;
			lidarrMsg = 'Type an artist name first.';
			return;
		}
		lidarrMsg = 'Adding artist to Lidarr...';
		lidarrOk = null;
		const { ok, data: json } = await post<{ success: boolean; message?: string }>(
			'/api/lidarr/add-artist',
			{ name: artistName.trim() }
		);
		lidarrOk = ok && json.success;
		lidarrMsg = json.message ?? (ok ? 'Done' : 'Failed');
		if (lidarrOk) artistName = '';
	}

	async function importDefaults() {
		if (!confirm(`Add all ${data.defaultArtistCount} default artists to Lidarr?`)) return;
		running = 'Importing default artists';
		const { ok, data: json } = await post<{ imported?: string[]; failed?: string[] }>(
			'/api/lidarr/import-default-artists'
		);
		running = null;
		if (ok) toastStore.show(`Imported ${json.imported?.length ?? 0}, failed ${json.failed?.length ?? 0}`);
	}
</script>

<PageHeader
	title="Manage"
	description="Housekeeping: pull in new music, refresh your likes, and tell Lidarr which artists to watch. Run a job when something's missing — each one remembers its last result below."
/>

<div class="grid gap-6 lg:grid-cols-2">
	<section class="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
		<h2 class="text-lg font-bold text-gray-900">New music</h2>
		<p class="mb-4 text-sm text-gray-500">These can take a while — you can leave this page, the result is saved here.</p>
		<div class="grid gap-2">
			<button
				class="rounded-xl bg-blue-600 px-5 py-2.5 text-left font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
				disabled={running !== null}
				onclick={() => runJob('Check for new music', '/api/index-library')}
			>
				Check for new music
				<span class="block text-xs font-normal opacity-80">Finds songs added to Music Assistant since last time</span>
			</button>
			<p class="px-1 text-xs text-gray-400">{lastRunLine('index-library')}</p>
			<button
				class="rounded-xl bg-blue-600 px-5 py-2.5 text-left font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
				disabled={running !== null}
				onclick={() => runJob('Refresh liked songs', '/api/sync-favorites')}
			>
				Refresh liked songs
				<span class="block text-xs font-normal opacity-80">Re-imports your ♥ likes so mixes learn your taste</span>
			</button>
			<p class="px-1 text-xs text-gray-400">{lastRunLine('sync-favorites')}</p>
			<button
				class="rounded-xl bg-blue-600 px-5 py-2.5 text-left font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
				disabled={running !== null}
				onclick={() => runJob('Full tidy-up', '/api/analyze', 'The full tidy-up syncs Music Assistant (can take 10+ min), then finds and sorts new songs. Start it?')}
			>
				Full tidy-up
				<span class="block text-xs font-normal opacity-80">Syncs everything, finds new songs and sorts them into vibes</span>
			</button>
			<p class="px-1 text-xs text-gray-400">{lastRunLine('analyze')}</p>
		</div>
		{#if running}<p class="mt-3 text-sm text-gray-500">{running}… this may take a few minutes.</p>{/if}
	</section>

	<section class="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
		<h2 class="text-lg font-bold text-gray-900">Artists to watch</h2>
		<p class="mb-4 text-sm text-gray-500">Lidarr watches these artists and their new releases show up in your library automatically.</p>
		<div class="flex flex-wrap gap-2">
			<input
				class="min-w-52 flex-1 rounded-xl border border-gray-300 px-3 py-2"
				placeholder="Artist name (e.g. Sampha)"
				bind:value={artistName}
				onkeydown={(e) => e.key === 'Enter' && addArtist()}
			/>
			<button class="rounded-xl bg-gray-600 px-5 py-2 font-semibold text-white hover:bg-gray-700" onclick={addArtist}>Add artist</button>
		</div>
		{#if lidarrMsg}
			<p class="mt-2 text-sm {lidarrOk ? 'text-green-600' : 'text-red-600'}">{lidarrMsg}</p>
		{/if}
		<button
			class="mt-4 rounded-xl bg-gray-600 px-5 py-2 font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
			disabled={running !== null}
			onclick={importDefaults}
		>
			Import default list ({data.defaultArtistCount} artists)
		</button>
	</section>
</div>
