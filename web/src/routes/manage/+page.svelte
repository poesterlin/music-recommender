<script lang="ts">
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { toastStore } from '$lib/client/toast.svelte';
	import { post } from '$lib/api';
	import {
		IconArrowUpRight,
		IconCopy,
		IconKey,
		IconActivity,
		IconCpu,
		IconRefresh
	} from '@tabler/icons-svelte';

	let { data } = $props();
	let playbackPlayerId = $state('');
	let savedPlaybackPlayerId = $state('');
	let savingPlayback = $state(false);
	let playbackMessage = $state('');
	let playbackError = $state(false);
	$effect(() => {
		playbackPlayerId = data.playbackPlayerId ?? '';
		savedPlaybackPlayerId = data.playbackPlayerId ?? '';
	});
	async function savePlaybackDevice() {
		if (savingPlayback || playbackPlayerId === savedPlaybackPlayerId) return;
		savingPlayback = true;
		playbackMessage = '';
		playbackError = false;
		const selected = playbackPlayerId;
		try {
			const response = await fetch('/api/playback-settings', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ playerId: selected || null })
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error ?? 'Could not save the playback device.');
			savedPlaybackPlayerId = selected;
			playbackMessage = 'Saved. Playback and player controls now use this selection.';
		} catch (error) {
			playbackError = true;
			playbackMessage = error instanceof Error ? error.message : 'Could not save. Try again.';
		} finally {
			savingPlayback = false;
		}
	}
	let embeddingMode = $state('medium');
	let sampleSeconds = $state(90);
	let settingsMessage = $state('');
	let settingsError = $state(false);
	let savingSettings = $state(false);
	let savedMode = $state('medium');
	let savedSampleSeconds = $state(90);
	const PROCESSING_PROFILES = [
		{
			mode: 'high',
			label: 'Light',
			hardware: 'Low-power CPU or shared server',
			detail: 'Fewer analysis windows. Finishes fastest and leaves more room for other services.',
			hop: 1
		},
		{
			mode: 'medium',
			label: 'Balanced',
			hardware: 'Everyday desktop or home server',
			detail: 'A middle ground between processing time and sampling detail.',
			hop: 0.5
		},
		{
			mode: 'low',
			label: 'Thorough',
			hardware: 'Powerful workstation or dedicated worker',
			detail:
				'Five times as many analysis windows as Balanced. Takes longer to process each track.',
			hop: 0.1
		}
	] as const;
	const COVERAGE_OPTIONS = [
		{ seconds: 30, label: 'Brief' },
		{ seconds: 60, label: 'Standard' },
		{ seconds: 90, label: 'Broad' },
		{ seconds: 120, label: 'Extended' }
	];
	const selectedProfile = $derived(
		PROCESSING_PROFILES.find((profile) => profile.mode === embeddingMode)
	);
	const settingsChanged = $derived(
		embeddingMode !== savedMode || sampleSeconds !== savedSampleSeconds
	);
	$effect(() => {
		embeddingMode = data.embeddingSettings.mode;
		sampleSeconds = data.embeddingSettings.maxSampleSeconds;
		savedMode = data.embeddingSettings.mode;
		savedSampleSeconds = data.embeddingSettings.maxSampleSeconds;
	});
	async function saveEmbeddingSettings() {
		if (savingSettings || data.embeddingSettingsLocked || !settingsChanged || !selectedProfile)
			return;
		savingSettings = true;
		settingsMessage = '';
		settingsError = false;
		const mode = embeddingMode;
		const seconds = sampleSeconds;
		try {
			const response = await fetch('/api/embedding-settings', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ mode, maxSampleSeconds: seconds })
			});
			const result = await response.json();
			if (!response.ok) throw new Error(result.error ?? 'Could not save analysis settings.');
			savedMode = mode;
			savedSampleSeconds = seconds;
			settingsMessage = 'Saved. All workers use these settings on their next run.';
		} catch (error) {
			settingsError = true;
			settingsMessage = error instanceof Error ? error.message : 'Could not save. Try again.';
		} finally {
			savingSettings = false;
		}
	}

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
</script>

<svelte:head><title>Manage · Sole</title></svelte:head>

<PageHeader
	kicker="Your library"
	title="Manage"
	description="Keep your collection in shape. Tune audio analysis, refresh your library, and connect your tools."
/>

<div class="mb-8 grid gap-3 sm:grid-cols-3">
	<a
		class="group border-ink/10 hover:border-accent/40 rounded-2xl border bg-white/70 p-4 transition"
		href="/manage/duplicates"
	>
		<span class="flex items-center gap-3"
			><span class="bg-accent/10 text-accent-deep rounded-lg p-2"><IconCopy size={20} /></span><span
				class="font-bold">Duplicates</span
			><IconArrowUpRight size={18} class="text-faded group-hover:text-accent-deep ml-auto" /></span
		>
		<span class="text-ink-soft mt-3 block text-sm">Review repeated tracks.</span>
	</a>
	<a
		class="group border-ink/10 hover:border-accent/40 rounded-2xl border bg-white/70 p-4 transition"
		href="/manage/access"
	>
		<span class="flex items-center gap-3"
			><span class="bg-accent/10 text-accent-deep rounded-lg p-2"><IconKey size={20} /></span><span
				class="font-bold">API keys</span
			><IconArrowUpRight size={18} class="text-faded group-hover:text-accent-deep ml-auto" /></span
		>
		<span class="text-ink-soft mt-3 block text-sm">Manage access for your tools.</span>
	</a>
	<a
		class="group border-ink/10 hover:border-accent/40 rounded-2xl border bg-white/70 p-4 transition"
		href="/status"
	>
		<span class="flex items-center gap-3"
			><span class="bg-accent/10 text-accent-deep rounded-lg p-2"><IconActivity size={20} /></span
			><span class="font-bold">Worker status</span><IconArrowUpRight
				size={18}
				class="text-faded group-hover:text-accent-deep ml-auto"
			/></span
		>
		<span class="text-ink-soft mt-3 block text-sm">Follow your library’s progress.</span>
	</a>
</div>

<section
	class="border-ink/10 mb-6 rounded-2xl border bg-white/80 p-5 shadow-sm sm:p-6"
	aria-labelledby="playback-device-title"
>
	<h2 id="playback-device-title" class="font-display text-xl font-bold">Playback device</h2>
	<p class="text-ink-soft mt-1 text-sm">
		Choose the speaker or sync group used for playback, player controls, and the main queue.
	</p>
	{#if !data.musicAssistant}<p class="text-ink-soft mt-3 text-sm">
			Connect Music Assistant to choose a device.
		</p>
	{:else if data.playbackUnavailable}<p class="text-accent-deep mt-3 text-sm">
			Music Assistant is unavailable. Reload this page to try again.
		</p>{/if}
	<form
		class="mt-5"
		onsubmit={(event) => {
			event.preventDefault();
			void savePlaybackDevice();
		}}
	>
		<label for="playback-device" class="mb-2 block text-sm font-bold">Default device</label>
		<div class="flex flex-col gap-3 sm:flex-row">
			<select
				id="playback-device"
				bind:value={playbackPlayerId}
				disabled={savingPlayback}
				class="border-ink/20 bg-paper focus:border-accent min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm outline-none disabled:opacity-50"
			>
				<option value="">Automatic · follow active playback</option>
				{#if data.playbackPlayerId && !data.playbackPlayers.some((player) => player.id === data.playbackPlayerId)}
					<option value={data.playbackPlayerId}
						>{data.playbackPlayerId} · not currently listed</option
					>
				{/if}
				{#each data.playbackPlayers as player (player.id)}<option value={player.id}
						>{player.name}{player.available ? '' : ' · offline'}</option
					>{/each}
			</select>
			<button
				type="submit"
				disabled={savingPlayback || playbackPlayerId === savedPlaybackPlayerId}
				class="bg-ink text-cream hover:bg-ink-soft cursor-pointer rounded-lg px-4 py-2 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-50"
				>{savingPlayback ? 'Saving…' : 'Save device'}</button
			>
		</div>
		<p class="text-ink-soft mt-2 text-xs">
			Automatic shows all device queues. A saved selection applies across restarts.
		</p>
		{#if playbackMessage}<p
				role={playbackError ? 'alert' : 'status'}
				class="mt-3 text-sm {playbackError ? 'text-accent-deep' : 'text-moss'}"
			>
				{playbackMessage}
			</p>{/if}
	</form>
</section>

<section
	class="border-ink/10 mb-6 rounded-2xl border bg-white/80 p-5 shadow-sm sm:p-6"
	aria-labelledby="analysis-settings-title"
>
	<div class="flex items-start gap-3">
		<div class="bg-accent/10 text-accent-deep rounded-xl p-2"><IconCpu size={22} /></div>
		<div>
			<h2 id="analysis-settings-title" class="font-display text-xl font-bold">Audio analysis</h2>
			<p class="text-ink-soft mt-1 text-sm">
				Choose how much work your embedding worker spends on each track.
			</p>
		</div>
	</div>
	{#if data.embeddingSettingsLocked}
		<p class="border-gold/30 bg-gold/10 text-ink-soft mt-4 rounded-xl border p-3 text-sm">
			These settings are fixed because your library already has embeddings. Keeping one analysis
			profile makes tracks comparable.
		</p>
	{/if}
	<form
		class="mt-5"
		onsubmit={(event) => {
			event.preventDefault();
			void saveEmbeddingSettings();
		}}
	>
		<fieldset disabled={data.embeddingSettingsLocked || savingSettings}>
			<legend class="mb-3 text-sm font-bold">Processing effort</legend>
			<div class="grid gap-3 lg:grid-cols-3">
				{#each PROCESSING_PROFILES as profile (profile.mode)}
					<label
						class="has-[:focus-visible]:ring-accent/50 flex flex-col rounded-xl border p-4 transition has-[:focus-visible]:ring-2 {embeddingMode ===
						profile.mode
							? 'border-accent/50 bg-accent/5'
							: 'border-ink/10 bg-paper/40'} {data.embeddingSettingsLocked || savingSettings
							? 'cursor-default'
							: 'hover:border-accent/40 cursor-pointer'}"
					>
						<span class="flex items-center gap-2">
							<input
								type="radio"
								name="processing-profile"
								value={profile.mode}
								bind:group={embeddingMode}
								class="accent-accent"
							/>
							<span class="font-bold">{profile.label}</span>
							{#if profile.mode === 'medium'}<span
									class="bg-ink/5 text-ink-soft ml-auto rounded-full px-2 py-0.5 text-xs font-bold"
									>Default</span
								>{/if}
						</span>
						<span class="text-ink-soft mt-2 text-sm font-bold">{profile.hardware}</span>
						<span class="text-ink-soft mt-1 text-sm leading-relaxed">{profile.detail}</span>
					</label>
				{/each}
			</div>
			{#if !selectedProfile}<p class="text-ink-soft mt-2 text-sm">
					Your library uses a custom processing profile.
				</p>{/if}
			<p class="text-ink-soft mt-3 text-xs">
				Choose for the machine running the worker. These are workload presets, not hardware
				detection; all use the same audio model.
			</p>
			<div class="mt-5 grid gap-2 sm:max-w-md">
				<label for="analysis-coverage" class="text-sm font-bold">Track coverage</label>
				<select
					id="analysis-coverage"
					bind:value={sampleSeconds}
					class="border-ink/20 bg-paper focus:border-accent rounded-lg border px-3 py-2 text-sm outline-none disabled:opacity-70"
				>
					{#if !COVERAGE_OPTIONS.some((option) => option.seconds === savedSampleSeconds)}<option
							value={savedSampleSeconds}>Existing coverage · {savedSampleSeconds} seconds</option
						>{/if}
					{#each COVERAGE_OPTIONS as option (option.seconds)}<option value={option.seconds}
							>{option.label} · up to {option.seconds} seconds</option
						>{/each}
				</select>
				<p class="text-ink-soft text-xs">
					Longer excerpts capture more of a track and take more time to analyse. Broad is the
					default; shorter tracks use their available audio.
				</p>
			</div>
		</fieldset>
		<details class="border-ink/10 text-ink-soft mt-4 border-t pt-4 text-xs">
			<summary class="cursor-pointer font-medium">Technical details</summary>
			<p class="mt-2">
				{selectedProfile ? selectedProfile.hop : data.embeddingSettings.hopSeconds}-second window
				spacing · up to {sampleSeconds} seconds per track · {data.embeddingSettings.frontend}
			</p>
		</details>
		<div class="mt-5 flex flex-wrap items-center gap-3">
			<button
				type="submit"
				disabled={data.embeddingSettingsLocked ||
					savingSettings ||
					!settingsChanged ||
					!selectedProfile}
				class="bg-ink text-cream hover:bg-ink-soft cursor-pointer rounded-lg px-4 py-2 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-50"
				>{savingSettings ? 'Saving…' : 'Save analysis settings'}</button
			>
			{#if settingsMessage}<p
					role={settingsError ? 'alert' : 'status'}
					class="text-sm {settingsError ? 'text-accent-deep' : 'text-moss'}"
				>
					{settingsMessage}
				</p>{/if}
		</div>
	</form>
</section>

<section class="border-ink/10 rounded-2xl border bg-white/80 p-5 shadow-sm sm:p-6">
	<div class="mb-5 flex items-start gap-3">
		<div class="bg-accent/10 text-accent-deep rounded-xl p-2"><IconRefresh size={22} /></div>
		<div>
			<h2 class="font-display text-xl font-bold">Library upkeep</h2>
			<p class="text-ink-soft mt-1 text-sm">
				Maintenance runs automatically while Sole is online. Check for changes whenever you need.
			</p>
		</div>
	</div>
	<div class="grid gap-3 lg:grid-cols-3">
		{#each JOBS as job (job.id)}
			<div class="border-ink/10 bg-paper/40 flex flex-col rounded-xl border p-4">
				<h3 class="font-bold">{job.label}</h3>
				<p class="text-ink-soft mt-1 flex-1 text-sm leading-relaxed">{job.detail}</p>
				<p class="text-accent-deep mt-4 text-xs font-bold">
					{job.scheduled === 'on demand' ? 'On demand' : `Automatically ${job.scheduled}`}
				</p>
				<p class="text-ink-soft mt-1 text-xs">{lastRunLine(job.id)}</p>
				<button
					class="border-ink/20 hover:bg-ink/5 mt-4 cursor-pointer rounded-lg border px-4 py-2 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-50"
					disabled={running !== null || !data.musicAssistant}
					onclick={() => runJob(job.label, job.path, 'confirm' in job ? job.confirm : undefined)}
				>
					{running === job.label ? 'Running…' : 'Run now'}
				</button>
			</div>
		{/each}
	</div>
	{#if running}
		<p class="text-ink-soft mt-3 text-sm" role="status">{running}… this may take a few minutes.</p>
	{/if}
	{#if !data.musicAssistant}<p class="text-ink-soft mt-4 text-sm">
			Connect Music Assistant in <a class="font-bold underline" href="/setup">Setup</a> to run these jobs.
		</p>{/if}
	{#if jobError}<p class="bg-accent/5 text-accent-deep mt-3 rounded-lg p-3 text-sm" role="alert">
			{jobError}
		</p>{/if}
</section>
