<script lang="ts">
	import { onMount } from 'svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';

	let { data } = $props();
	let status = $state(data);
	let refreshing = $state(false);
	let lastUpdated = $state(new Date(data.generatedAt));

	const counts = $derived(status.embedding.counts);
	const activeJob = $derived(status.embedding.activeJob);
	const latestRun = $derived(status.clustering.latestRun);
	const activeRun = $derived(status.clustering.activeRun);

	function formatNumber(value: number | null | undefined): string {
		return value === null || value === undefined ? '—' : new Intl.NumberFormat().format(value);
	}

	function formatDecimal(value: number | null | undefined, digits = 3): string {
		return value === null || value === undefined || !Number.isFinite(value)
			? '—'
			: value.toFixed(digits);
	}

	function formatPercent(value: number | null | undefined, digits = 1): string {
		return value === null || value === undefined || !Number.isFinite(value)
			? '—'
			: `${(value * 100).toFixed(digits)}%`;
	}

	function formatDate(value: string | Date | null | undefined): string {
		if (!value) return '—';
		const date = value instanceof Date ? value : new Date(value);
		return Number.isNaN(date.getTime())
			? '—'
			: date.toLocaleString(undefined, {
					dateStyle: 'medium',
					timeStyle: 'short'
				});
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

	function jobLabel(state: string): string {
		return {
			complete: 'Complete',
			incomplete: 'Incomplete',
			failed: 'Failed',
			unfinished: 'Unfinished',
			unknown: 'Unknown',
			'not-started': 'Not started'
		}[state] ?? state;
	}

	function jobTone(state: string): string {
		if (state === 'complete') return 'bg-moss/15 text-moss';
		if (state === 'failed' || state === 'incomplete') return 'bg-red-100 text-red-700';
		if (state === 'unfinished') return 'bg-amber-100 text-amber-800';
		return 'bg-gray-100 text-gray-700';
	}

	function runTone(statusValue: string): string {
		if (statusValue === 'applied') return 'bg-moss/15 text-moss';
		if (statusValue === 'completed') return 'bg-blue-100 text-blue-700';
		if (statusValue === 'failed' || statusValue === 'error') return 'bg-red-100 text-red-700';
		return 'bg-gray-100 text-gray-700';
	}

	function qualityValue(value: number | null | undefined): string {
		return formatDecimal(value, 4);
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
	title="Pipeline status"
	description="A read-only view of embedding coverage, worker checkpoints, and the latest clustering quality. Nothing on this page starts a job or changes the database."
	kicker="Operations"
/>

<div class="mb-6 flex flex-wrap items-center justify-between gap-3 text-sm text-ink-soft">
	<p>Last refreshed {formatDate(lastUpdated)} · page polls every 30 seconds</p>
	<button
		class="rounded-full border border-ink/20 bg-cream px-4 py-2 font-bold transition hover:border-ink/50 hover:bg-white disabled:opacity-50"
		disabled={refreshing}
		onclick={refresh}
	>
		{refreshing ? 'Refreshing…' : 'Refresh now'}
	</button>
</div>

{#if status.errors.length > 0}
	<section class="mb-6 rounded-2xl border border-amber-300 bg-amber-50 p-5 text-amber-950">
		<h2 class="font-bold">Some status sources are unavailable</h2>
		<ul class="mt-2 list-disc space-y-1 pl-5 text-sm">
			{#each status.errors as error}
				<li>{error}</li>
			{/each}
		</ul>
		<p class="mt-3 text-sm">The page is read-only and will keep showing the sections that are available.</p>
	</section>
{/if}

<section class="mb-8 rounded-3xl border border-line bg-cream p-6 shadow-sm sm:p-8">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<p class="text-xs font-bold tracking-[0.24em] text-accent-deep uppercase">01 · Embeddings</p>
			<h2 class="mt-1 font-display text-3xl font-black">Library coverage</h2>
		</div>
		{#if status.embedding.space}
			<span class="rounded-full bg-ink px-3 py-1 text-xs font-bold text-cream">
				space v{status.embedding.space.version} · {status.embedding.space.model}
			</span>
		{/if}
	</div>

	<div class="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
		<div class="rounded-2xl border border-line bg-white/70 p-4">
			<p class="text-xs font-bold tracking-wide text-ink-soft uppercase">Total tracks</p>
			<p class="mt-2 font-display text-3xl font-black">{formatNumber(counts.total)}</p>
		</div>
		<div class="rounded-2xl border border-line bg-white/70 p-4">
			<p class="text-xs font-bold tracking-wide text-ink-soft uppercase">Embedded</p>
			<p class="mt-2 font-display text-3xl font-black text-moss">{formatNumber(counts.embedded)}</p>
		</div>
		<div class="rounded-2xl border border-line bg-white/70 p-4">
			<p class="text-xs font-bold tracking-wide text-ink-soft uppercase">Pending</p>
			<p class="mt-2 font-display text-3xl font-black text-accent-deep">{formatNumber(counts.pending)}</p>
		</div>
		<div class="rounded-2xl border border-line bg-white/70 p-4">
			<p class="text-xs font-bold tracking-wide text-ink-soft uppercase">Centered</p>
			<p class="mt-2 font-display text-3xl font-black">{formatNumber(counts.centered)}</p>
		</div>
	</div>

	<div class="mt-6 rounded-2xl border border-line bg-white/70 p-5">
		<div class="mb-2 flex items-center justify-between gap-3 text-sm">
			<span class="font-bold">Embedding progress</span>
			<span class="text-ink-soft">{formatPercent(progress(counts.embedded, counts.total), 1)}</span>
		</div>
		<div class="h-3 overflow-hidden rounded-full bg-line">
			<div
				class="h-full rounded-full bg-moss transition-all"
				style={`width: ${progress(counts.embedded, counts.total)}%`}
			></div>
		</div>
		<div class="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-soft">
			<span>{formatNumber(counts.pending)} pending</span>
			<span>{formatNumber(counts.skipped)} skipped</span>
			<span>{formatNumber(counts.versioned)} versioned</span>
			<span>Last track update {relativeTime(counts.lastUpdated)}</span>
		</div>
	</div>

	<div class="mt-6 grid gap-4 lg:grid-cols-2">
		<div class="rounded-2xl border border-line bg-white/70 p-5">
			<div class="flex items-center justify-between gap-3">
				<h3 class="font-bold">Python worker</h3>
				{#if activeJob}
					<span class={`rounded-full px-2.5 py-1 text-xs font-bold ${jobTone(activeJob.state)}`}>
						{jobLabel(activeJob.state)}
					</span>
				{/if}
			</div>
			{#if activeJob}
				<div class="mt-4 grid grid-cols-2 gap-3 text-sm">
					<div><p class="text-xs text-ink-soft">Job</p><p class="font-mono">{activeJob.job}</p></div>
					<div><p class="text-xs text-ink-soft">Run ID</p><p class="font-mono">#{activeJob.id}</p></div>
					<div><p class="text-xs text-ink-soft">Processed</p><p class="font-bold">{formatNumber(activeJob.processed)}</p></div>
					<div><p class="text-xs text-ink-soft">Failed</p><p class="font-bold">{formatNumber(activeJob.failed)}</p></div>
					<div><p class="text-xs text-ink-soft">Remaining</p><p class="font-bold">{formatNumber(activeJob.remaining)}</p></div>
					<div><p class="text-xs text-ink-soft">Last batch</p><p>{formatDate(activeJob.lastBatchAt)}</p></div>
				</div>
				{#if activeJob.lastError}
					<p class="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-800">{activeJob.lastError}</p>
				{/if}
			{:else}
				<p class="mt-4 text-sm text-ink-soft">No Python embedding job has been recorded yet.</p>
			{/if}
		</div>

		<div class="rounded-2xl border border-line bg-white/70 p-5">
			<h3 class="font-bold">Embedding space</h3>
			{#if status.embedding.space}
				<div class="mt-4 grid grid-cols-2 gap-3 text-sm">
					<div><p class="text-xs text-ink-soft">Version</p><p class="font-bold">{status.embedding.space.version}</p></div>
					<div><p class="text-xs text-ink-soft">Model</p><p class="font-bold">{status.embedding.space.model}</p></div>
					<div><p class="text-xs text-ink-soft">Source tracks</p><p class="font-bold">{formatNumber(status.embedding.space.trackCount)}</p></div>
					<div><p class="text-xs text-ink-soft">Created</p><p>{formatDate(status.embedding.space.createdAt)}</p></div>
				</div>
			{:else}
				<p class="mt-4 text-sm text-ink-soft">No active embedding space is available.</p>
			{/if}
		</div>
	</div>

	<div class="mt-6 overflow-x-auto rounded-2xl border border-line bg-white/70">
		<table class="w-full min-w-[720px] text-left text-sm">
			<thead class="border-b border-line text-xs tracking-wide text-ink-soft uppercase">
				<tr><th class="px-4 py-3">Run</th><th class="px-4 py-3">State</th><th class="px-4 py-3">Processed</th><th class="px-4 py-3">Failed</th><th class="px-4 py-3">Remaining</th><th class="px-4 py-3">Last activity</th></tr>
			</thead>
			<tbody>
				{#each status.embedding.jobs as job (job.id)}
					<tr class="border-b border-line/70 last:border-0">
						<td class="px-4 py-3 font-mono">#{job.id}</td>
						<td class="px-4 py-3"><span class={`rounded-full px-2 py-0.5 text-xs font-bold ${jobTone(job.state)}`}>{jobLabel(job.state)}</span></td>
						<td class="px-4 py-3">{formatNumber(job.processed)}</td>
						<td class="px-4 py-3">{formatNumber(job.failed)}</td>
						<td class="px-4 py-3">{formatNumber(job.remaining)}</td>
						<td class="px-4 py-3 text-ink-soft">{formatDate(job.finishedAt ?? job.lastBatchAt ?? job.startedAt)}</td>
					</tr>
				{:else}
					<tr><td colspan="6" class="px-4 py-6 text-center text-ink-soft">No embedding runs recorded.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
</section>

<section class="rounded-3xl border border-line bg-cream p-6 shadow-sm sm:p-8">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<p class="text-xs font-bold tracking-[0.24em] text-accent-deep uppercase">02 · Clustering</p>
			<h2 class="mt-1 font-display text-3xl font-black">Quality and generations</h2>
		</div>
		<span class="rounded-full bg-ink px-3 py-1 text-xs font-bold text-cream">
			{formatNumber(counts.clustered)} clustered · {formatNumber(counts.unclustered)} unassigned
		</span>
	</div>

	<div class="mt-6 grid gap-4 lg:grid-cols-2">
		<div class="rounded-2xl border border-line bg-white/70 p-5">
			<div class="flex items-center justify-between gap-3">
				<h3 class="font-bold">Active generation</h3>
				{#if activeRun}<span class={`rounded-full px-2.5 py-1 text-xs font-bold ${runTone(activeRun.status)}`}>{activeRun.status}</span>{/if}
			</div>
			{#if activeRun}
				<div class="mt-4 grid grid-cols-2 gap-3 text-sm">
					<div><p class="text-xs text-ink-soft">Run</p><p class="font-mono">#{activeRun.id}</p></div>
					<div><p class="text-xs text-ink-soft">Clusters</p><p class="font-bold">{formatNumber(activeRun.k)}</p></div>
					<div><p class="text-xs text-ink-soft">Tracks</p><p class="font-bold">{formatNumber(activeRun.trackCount)}</p></div>
					<div><p class="text-xs text-ink-soft">Applied</p><p>{formatDate(activeRun.appliedAt)}</p></div>
				</div>
			{:else}
				<p class="mt-4 text-sm text-ink-soft">No clustering generation has been explicitly applied.</p>
			{/if}
		</div>

		<div class="rounded-2xl border border-line bg-white/70 p-5">
			<div class="flex items-center justify-between gap-3">
				<h3 class="font-bold">Latest recorded run</h3>
				{#if latestRun}<span class={`rounded-full px-2.5 py-1 text-xs font-bold ${runTone(latestRun.status)}`}>{latestRun.status}</span>{/if}
			</div>
			{#if latestRun}
				<div class="mt-4 grid grid-cols-2 gap-3 text-sm">
					<div><p class="text-xs text-ink-soft">Run</p><p class="font-mono">#{latestRun.id} · {latestRun.mode}</p></div>
					<div><p class="text-xs text-ink-soft">Clusters</p><p class="font-bold">{formatNumber(latestRun.k)}</p></div>
					<div><p class="text-xs text-ink-soft">Tracks</p><p class="font-bold">{formatNumber(latestRun.trackCount)}</p></div>
					<div><p class="text-xs text-ink-soft">Completed</p><p>{formatDate(latestRun.completedAt ?? latestRun.createdAt)}</p></div>
				</div>
				{#if latestRun.error}<p class="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-800">{latestRun.error}</p>{/if}
			{:else}
				<p class="mt-4 text-sm text-ink-soft">No clustering runs have been recorded.</p>
			{/if}
		</div>
	</div>

	{#if latestRun?.bestRun}
		<div class="mt-6 rounded-2xl border border-line bg-white/70 p-5">
			<div class="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h3 class="font-bold">Best-run quality</h3>
					<p class="mt-1 text-xs text-ink-soft">Seed {formatNumber(latestRun.bestRun.seed)} · {formatNumber(latestRun.bestRun.iterations)} iterations · {latestRun.bestRun.converged ? 'converged' : 'not converged'}</p>
				</div>
				<div class="text-right text-xs text-ink-soft"><p>Mean pairwise ARI</p><p class="text-lg font-bold text-ink">{formatDecimal(latestRun.meanPairwiseAri, 4)}</p></div>
			</div>
			<div class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
				<div><p class="text-xs text-ink-soft">Intra similarity</p><p class="mt-1 text-xl font-bold">{qualityValue(latestRun.bestRun.quality.meanIntraSimilarity)}</p></div>
				<div><p class="text-xs text-ink-soft">Silhouette</p><p class="mt-1 text-xl font-bold">{qualityValue(latestRun.bestRun.quality.silhouette)}</p></div>
				<div><p class="text-xs text-ink-soft">Inertia</p><p class="mt-1 text-xl font-bold">{qualityValue(latestRun.bestRun.quality.inertia)}</p></div>
				<div><p class="text-xs text-ink-soft">Cluster size range</p><p class="mt-1 text-xl font-bold">{formatNumber(latestRun.bestRun.quality.minClusterSize)}–{formatNumber(latestRun.bestRun.quality.maxClusterSize)}</p></div>
			</div>
			{#if latestRun.pca.explainedVariance.length > 0}
				<div class="mt-5 border-t border-line pt-4">
					<p class="text-xs font-bold tracking-wide text-ink-soft uppercase">PCA explained variance</p>
					<div class="mt-3 flex h-3 overflow-hidden rounded-full bg-line">
						{#each latestRun.pca.explainedVariance.slice(0, 12) as value}
							<div class="h-full border-r border-cream/70 bg-accent/70" style={`width: ${Math.max(0, Math.min(100, value * 100))}%`} title={formatPercent(value)}></div>
						{/each}
					</div>
				</div>
			{/if}
		</div>
	{/if}

	<div class="mt-6 grid gap-6 lg:grid-cols-[1fr_1.2fr]">
		<div class="rounded-2xl border border-line bg-white/70 p-5">
			<h3 class="font-bold">Largest clusters</h3>
			<div class="mt-4 space-y-3">
				{#each status.clustering.topClusters as cluster (cluster.clusterId)}
					<div>
						<div class="mb-1 flex justify-between text-xs"><span class="font-mono">Cluster {cluster.clusterId}</span><span class="text-ink-soft">{formatNumber(cluster.trackCount)}</span></div>
						<div class="h-2 overflow-hidden rounded-full bg-line"><div class="h-full rounded-full bg-accent" style={`width: ${progress(cluster.trackCount, Math.max(...status.clustering.topClusters.map((item) => item.trackCount), 1))}%`}></div></div>
					</div>
				{:else}
					<p class="text-sm text-ink-soft">No cluster distribution available.</p>
				{/each}
			</div>
		</div>

		<div class="overflow-x-auto rounded-2xl border border-line bg-white/70">
			<table class="w-full min-w-[620px] text-left text-sm">
				<thead class="border-b border-line text-xs tracking-wide text-ink-soft uppercase"><tr><th class="px-4 py-3">Run</th><th class="px-4 py-3">State</th><th class="px-4 py-3">K</th><th class="px-4 py-3">Tracks</th><th class="px-4 py-3">Created</th></tr></thead>
				<tbody>
					{#each status.clustering.runs as run (run.id)}
						<tr class="border-b border-line/70 last:border-0"><td class="px-4 py-3 font-mono">#{run.id} · {run.mode}</td><td class="px-4 py-3"><span class={`rounded-full px-2 py-0.5 text-xs font-bold ${runTone(run.status)}`}>{run.status}</span></td><td class="px-4 py-3">{formatNumber(run.k)}</td><td class="px-4 py-3">{formatNumber(run.trackCount)}</td><td class="px-4 py-3 text-ink-soft">{formatDate(run.createdAt)}</td></tr>
					{:else}
						<tr><td colspan="5" class="px-4 py-6 text-center text-ink-soft">No clustering runs recorded.</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
</section>

<p class="mt-6 text-center text-xs text-ink-soft">Read-only diagnostics · refreshes use the same database queries as the server load.</p>
