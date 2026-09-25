<script lang="ts">
	import { onMount } from 'svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';

	let { data } = $props();
	let status = $state(data);
	let refreshing = $state(false);
	let lastUpdated = $state(new Date(data.generatedAt));

	const counts = $derived(status.embedding.counts);
	const worker = $derived(status.embedding.worker);
	const activeJob = $derived(status.embedding.activeJob);
	const clusters = $derived(status.clusters);

	// A worker that has not spoken in a while is the signal you actually want:
	// "it stopped" and "it finished" look identical without a heartbeat.
	const WORKER_STALE_MINUTES = 15;
	const workerMinutes = $derived(
		worker.lastSeenAt ? (Date.now() - new Date(worker.lastSeenAt).getTime()) / 60000 : null
	);
	const workerState = $derived.by((): 'idle' | 'running' | 'stale' => {
		if (!worker.active || workerMinutes === null) return 'idle';
		return workerMinutes <= WORKER_STALE_MINUTES ? 'running' : 'stale';
	});

	const UPKEEP_LABELS: Record<string, string> = {
		analyze: 'Full tidy-up',
		'index-library': 'Check for new music',
		'sync-favorites': 'Refresh liked songs'
	};

	function formatNumber(value: number | null | undefined): string {
		return value === null || value === undefined ? '—' : new Intl.NumberFormat().format(value);
	}

	function formatSeconds(value: number | null | undefined): string {
		return value === null || value === undefined ? '—' : `${value.toFixed(1)}s`;
	}

	function formatDate(value: string | Date | null | undefined): string {
		if (!value) return '—';
		const date = value instanceof Date ? value : new Date(value);
		return Number.isNaN(date.getTime())
			? '—'
			: date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	}

	function relativeTime(value: string | Date | null | undefined): string {
		if (!value) return 'never';
		const date = value instanceof Date ? value : new Date(value);
		if (Number.isNaN(date.getTime())) return 'unknown';
		const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
		if (minutes < 1) return 'just now';
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.round(minutes / 60);
		if (hours < 48) return `${hours}h ago`;
		return `${Math.round(hours / 24)}d ago`;
	}

	function progress(value: number, total: number): number {
		return total > 0 ? Math.min(100, Math.max(0, (value / total) * 100)) : 0;
	}

	function formatProgress(value: number, total: number, digits = 1): string {
		return `${progress(value, total).toFixed(digits)}%`;
	}

	function jobLabel(state: string): string {
		return (
			{
				complete: 'Complete',
				incomplete: 'Incomplete',
				failed: 'Failed',
				unfinished: 'Running',
				unknown: 'Unknown',
				'not-started': 'Not started'
			}[state] ?? state
		);
	}

	function jobTone(state: string): string {
		if (state === 'complete') return 'bg-moss/15 text-moss';
		if (state === 'failed' || state === 'incomplete') return 'bg-red-100 text-red-700';
		if (state === 'unfinished') return 'bg-amber-100 text-amber-800';
		return 'bg-gray-100 text-gray-700';
	}

	async function refresh() {
		if (refreshing) return;
		refreshing = true;
		try {
			const response = await fetch('/api/status', { headers: { accept: 'application/json' } });
			if (!response.ok) throw new Error(`status request failed (${response.status})`);
			status = (await response.json()) as typeof status;
			lastUpdated = new Date();
		} catch (error) {
			console.error(error);
		} finally {
			refreshing = false;
		}
	}

	onMount(() => {
		const timer = setInterval(() => void refresh(), 30_000);
		return () => clearInterval(timer);
	});
</script>

<PageHeader
	title="Worker"
	description="Embedding coverage, worker liveness, and upkeep jobs. Read-only — nothing here starts a job."
	kicker="Operations"
/>

<div class="text-ink-soft mb-6 flex flex-wrap items-center justify-between gap-3 text-sm">
	<p>Updated {formatDate(lastUpdated)} · refreshes every 30s</p>
	<button
		class="border-ink/20 bg-cream hover:border-ink/50 rounded-full border px-4 py-2 font-bold transition hover:bg-white disabled:opacity-50"
		disabled={refreshing}
		onclick={refresh}
	>
		{refreshing ? 'Refreshing…' : 'Refresh'}
	</button>
</div>

{#if status.errors.length > 0}
	<section class="mb-6 rounded-2xl border border-amber-300 bg-amber-50 p-5 text-amber-950">
		<h2 class="font-bold">Some sources are unavailable</h2>
		<ul class="mt-2 list-disc space-y-1 pl-5 text-sm">
			{#each status.errors as error, i (i)}
				<li>{error}</li>
			{/each}
		</ul>
	</section>
{/if}

<section class="border-line bg-cream mb-8 rounded-3xl border p-6 shadow-sm sm:p-8">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<p class="text-accent-deep text-xs font-bold tracking-[0.24em] uppercase">01 · Embeddings</p>
			<h2 class="font-display mt-1 text-3xl font-black">Coverage</h2>
		</div>
		{#if status.embedding.space}
			<span class="bg-ink text-cream rounded-full px-3 py-1 text-xs font-bold">
				space v{status.embedding.space.version} · {status.embedding.space.model}
			</span>
		{/if}
	</div>

	<div class="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
		<div class="border-line rounded-2xl border bg-white/70 p-4">
			<p class="text-ink-soft text-xs font-bold tracking-wide uppercase">Total tracks</p>
			<p class="font-display mt-2 text-3xl font-black">{formatNumber(counts.total)}</p>
		</div>
		<div class="border-line rounded-2xl border bg-white/70 p-4">
			<p class="text-ink-soft text-xs font-bold tracking-wide uppercase">Embedded</p>
			<p class="font-display text-moss mt-2 text-3xl font-black">{formatNumber(counts.embedded)}</p>
		</div>
		<div class="border-line rounded-2xl border bg-white/70 p-4">
			<p class="text-ink-soft text-xs font-bold tracking-wide uppercase">Pending</p>
			<p class="font-display text-accent-deep mt-2 text-3xl font-black">
				{formatNumber(counts.pending)}
			</p>
		</div>
		<div class="border-line rounded-2xl border bg-white/70 p-4">
			<p class="text-ink-soft text-xs font-bold tracking-wide uppercase">Unclustered</p>
			<p class="font-display mt-2 text-3xl font-black">{formatNumber(counts.unclustered)}</p>
		</div>
	</div>

	<div class="border-line mt-6 rounded-2xl border bg-white/70 p-5">
		<div class="mb-2 flex items-center justify-between gap-3 text-sm">
			<span class="font-bold">Progress</span>
			<span class="text-ink-soft">{formatProgress(counts.embedded, counts.total)}</span>
		</div>
		<div class="bg-line h-3 overflow-hidden rounded-full">
			<div
				class="bg-moss h-full rounded-full transition-all"
				style={`width: ${progress(counts.embedded, counts.total)}%`}
			></div>
		</div>
		<div class="text-ink-soft mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs">
			<span>{formatNumber(counts.pending)} pending</span>
			<span>{formatNumber(counts.skipped)} skipped</span>
			<span>{formatNumber(counts.centered)} centered</span>
			<span>last write {relativeTime(counts.lastUpdated)}</span>
		</div>
	</div>
</section>

<section class="border-line bg-cream mb-8 rounded-3xl border p-6 shadow-sm sm:p-8">
	<div>
		<p class="text-accent-deep text-xs font-bold tracking-[0.24em] uppercase">02 · Worker</p>
		<h2 class="font-display mt-1 text-3xl font-black">Liveness</h2>
	</div>

	<div class="mt-6 grid gap-4 lg:grid-cols-2">
		<div class="border-line rounded-2xl border bg-white/70 p-5">
			<div class="flex items-center justify-between gap-3">
				<h3 class="font-bold">Portable worker</h3>
				<span
					class={`rounded-full px-2.5 py-1 text-xs font-bold ${
						workerState === 'running'
							? 'bg-moss/15 text-moss'
							: workerState === 'stale'
								? 'bg-amber-100 text-amber-800'
								: 'bg-gray-100 text-gray-700'
					}`}
				>
					{workerState === 'running' ? 'Running' : workerState === 'stale' ? 'Stalled' : 'No data'}
				</span>
			</div>
			{#if worker.active}
				<div class="mt-4 grid grid-cols-2 gap-3 text-sm">
					<div>
						<p class="text-ink-soft text-xs">Last upload</p>
						<p class="font-bold">{relativeTime(worker.lastSeenAt)}</p>
					</div>
					<div>
						<p class="text-ink-soft text-xs">Written this run</p>
						<p class="font-bold">{formatNumber(worker.written)}</p>
					</div>
					<div>
						<p class="text-ink-soft text-xs">Rejected</p>
						<p class="font-bold">{formatNumber(worker.failed)}</p>
					</div>
					<div>
						<p class="text-ink-soft text-xs">Per track</p>
						<p class="font-bold">{formatSeconds(worker.secondsPerTrack)}</p>
					</div>
				</div>
				<p class="text-ink-soft mt-4 text-xs">
					Run started {relativeTime(worker.startedAt)} · uploads are the only heartbeat, so silence past
					{WORKER_STALE_MINUTES}m means it stopped.
				</p>
			{:else}
				<p class="text-ink-soft mt-4 text-sm">
					No uploads recorded. Start the worker with a Worker API key from Manage → Access.
				</p>
			{/if}
		</div>

		<div class="border-line rounded-2xl border bg-white/70 p-5">
			<div class="flex items-center justify-between gap-3">
				<h3 class="font-bold">Local worker</h3>
				{#if activeJob}
					<span class={`rounded-full px-2.5 py-1 text-xs font-bold ${jobTone(activeJob.state)}`}>
						{jobLabel(activeJob.state)}
					</span>
				{/if}
			</div>
			{#if activeJob}
				<div class="mt-4 grid grid-cols-2 gap-3 text-sm">
					<div>
						<p class="text-ink-soft text-xs">Job</p>
						<p class="font-mono">{activeJob.job}</p>
					</div>
					<div>
						<p class="text-ink-soft text-xs">Run</p>
						<p class="font-mono">#{activeJob.id}</p>
					</div>
					<div>
						<p class="text-ink-soft text-xs">Processed</p>
						<p class="font-bold">{formatNumber(activeJob.processed)}</p>
					</div>
					<div>
						<p class="text-ink-soft text-xs">Remaining</p>
						<p class="font-bold">{formatNumber(activeJob.remaining)}</p>
					</div>
				</div>
				{#if activeJob.lastError}
					<p class="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-800">{activeJob.lastError}</p>
				{/if}
			{:else}
				<p class="text-ink-soft mt-4 text-sm">No local embedding run recorded.</p>
			{/if}
		</div>
	</div>

	{#if status.embedding.jobs.length > 0}
		<div class="border-line mt-6 overflow-x-auto rounded-2xl border bg-white/70">
			<table class="w-full min-w-[620px] text-left text-sm">
				<thead class="border-line text-ink-soft border-b text-xs tracking-wide uppercase">
					<tr
						><th class="px-4 py-3">Run</th><th class="px-4 py-3">State</th><th class="px-4 py-3"
							>Processed</th
						><th class="px-4 py-3">Failed</th><th class="px-4 py-3">Last activity</th></tr
					>
				</thead>
				<tbody>
					{#each status.embedding.jobs as job (job.id)}
						<tr class="border-line/70 border-b last:border-0">
							<td class="px-4 py-3 font-mono">#{job.id} · {job.job}</td>
							<td class="px-4 py-3"
								><span class={`rounded-full px-2 py-0.5 text-xs font-bold ${jobTone(job.state)}`}
									>{jobLabel(job.state)}</span
								></td
							>
							<td class="px-4 py-3">{formatNumber(job.processed)}</td>
							<td class="px-4 py-3">{formatNumber(job.failed)}</td>
							<td class="text-ink-soft px-4 py-3"
								>{relativeTime(job.finishedAt ?? job.lastBatchAt ?? job.startedAt)}</td
							>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<section class="border-line bg-cream mb-8 rounded-3xl border p-6 shadow-sm sm:p-8">
	<div>
		<p class="text-accent-deep text-xs font-bold tracking-[0.24em] uppercase">03 · Upkeep</p>
		<h2 class="font-display mt-1 text-3xl font-black">Library jobs</h2>
	</div>

	<div class="mt-6 grid gap-4 lg:grid-cols-3">
		{#each status.upkeep as job (job.job)}
			<div class="border-line rounded-2xl border bg-white/70 p-5">
				<div class="flex items-center justify-between gap-3">
					<h3 class="font-bold">{UPKEEP_LABELS[job.job] ?? job.job}</h3>
					<span
						class={`rounded-full px-2 py-0.5 text-xs font-bold ${
							job.ok === true
								? 'bg-moss/15 text-moss'
								: job.ok === false
									? 'bg-red-100 text-red-700'
									: 'bg-gray-100 text-gray-700'
						}`}
					>
						{job.ok === true ? 'OK' : job.ok === false ? 'Failed' : 'Never'}
					</span>
				</div>
				<p class="text-ink-soft mt-3 text-sm">
					{job.detail ?? 'Not run yet.'}
				</p>
				<p class="text-ink-soft mt-2 text-xs">
					{job.finishedAt
						? `${relativeTime(job.finishedAt)} · ${job.source === 'automatic' ? 'scheduled' : 'manual'}`
						: 'No run recorded'}
				</p>
			</div>
		{/each}
	</div>
</section>

<section class="border-line bg-cream rounded-3xl border p-6 shadow-sm sm:p-8">
	<div>
		<p class="text-accent-deep text-xs font-bold tracking-[0.24em] uppercase">04 · Clusters</p>
		<h2 class="font-display mt-1 text-3xl font-black">Distribution</h2>
	</div>

	<div class="mt-6 grid gap-6 lg:grid-cols-2">
		<div class="border-line rounded-2xl border bg-white/70 p-5">
			<p class="text-sm font-bold">
				{formatNumber(clusters.clustered)} assigned · {formatNumber(clusters.unclustered)} unassigned
			</p>
			<div class="mt-4 space-y-3">
				{#each clusters.topClusters as cluster (cluster.clusterId)}
					{@const largest = Math.max(...clusters.topClusters.map((item) => item.trackCount), 1)}
					<div>
						<div class="mb-1 flex justify-between text-xs">
							<span class="font-mono">Cluster {cluster.clusterId}</span>
							<span class="text-ink-soft">{formatNumber(cluster.trackCount)}</span>
						</div>
						<div class="bg-line h-2 overflow-hidden rounded-full">
							<div
								class="bg-accent h-full rounded-full"
								style={`width: ${progress(cluster.trackCount, largest)}%`}
							></div>
						</div>
					</div>
				{:else}
					<p class="text-ink-soft text-sm">No clusters assigned yet.</p>
				{/each}
			</div>
		</div>

		<div class="border-line rounded-2xl border bg-white/70 p-5">
			<h3 class="text-sm font-bold">How assignments happen</h3>
			<p class="text-ink-soft mt-3 text-sm">
				Embedding a track only produces a vector. Category assignment is separate: the full tidy-up
				assigns embedded but unclustered tracks to the nearest stored centroid, and never changes an
				existing assignment.
			</p>
			<p class="text-ink-soft mt-3 text-sm">
				{formatNumber(counts.embedded - counts.unclustered)} of {formatNumber(counts.embedded)} embedded
				tracks have a category.
			</p>
		</div>
	</div>
</section>
