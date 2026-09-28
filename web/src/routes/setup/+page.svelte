<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { post } from '$lib/api';
	import { toastStore } from '$lib/client/toast.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	type StepId = 'environment' | 'library' | 'index' | 'embed' | 'cluster' | 'name' | 'covers';
	type Status = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped';
	type StepState = { status: Status; detail: string; at: string | null };
	type KInfo = {
		clusterable: number;
		k: number;
		logK: number;
		capK: number;
		capped: boolean;
		meanPerCluster: number;
		explanation: string;
	};
	type SetupState = {
		running: boolean;
		paused: boolean;
		complete: boolean;
		current: StepId | null;
		steps: Record<StepId, StepState>;
		k: KInfo | null;
		startedAt: string | null;
	};

	// Server-rendered starting point. Deliberately the initial value only: the
	// live state comes from polling, and re-reading `data` would fight it.
	const initial: SetupState = data.state;

	// Named `setup` rather than `state` so it cannot be confused with the
	// `$state` rune it is declared with.
	let setup = $state<SetupState>(initial);
	let busy = $state(false);
	let retrying = $state<StepId | null>(null);

	// The server runner keeps going without us, so the page only has to watch.
	let watching = $derived(setup.running || setup.paused);

	async function refresh(): Promise<void> {
		const res = await fetch('/api/setup');
		if (!res.ok) return;
		const json = (await res.json()) as { state?: SetupState };
		if (json?.state) setup = json.state;
	}

	$effect(() => {
		if (!watching) return;
		let cancelled = false;
		const timer = setInterval(() => {
			if (cancelled) return;
			// A transient failure is fine; the next tick tries again.
			void refresh().catch(() => undefined);
		}, 4000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	});

	async function start() {
		busy = true;
		const { ok } = await post('/api/setup/run', { action: 'start' });
		busy = false;
		if (!ok) return;
		await refresh();
		await invalidateAll();
	}

	async function retry(id: StepId) {
		retrying = id;
		const { ok, data: json } = await post<{ state: SetupState }>('/api/setup/run', {
			action: 'retry',
			step: id
		});
		retrying = null;
		if (!ok) {
			toastStore.show('That step could not be re-run');
			return;
		}
		setup = json.state;
		await invalidateAll();
	}

	const STATUS_TEXT: Record<Status, string> = {
		pending: 'Ready',
		running: 'Working',
		waiting: 'Waiting',
		done: 'Done',
		failed: 'Failed',
		skipped: 'Skipped'
	};

	function pill(status: Status): string {
		switch (status) {
			case 'done':
				return 'bg-moss/10 text-moss border-moss/25';
			case 'running':
				return 'bg-accent/10 text-accent-deep border-accent/30';
			case 'waiting':
				return 'bg-gold/15 text-gold border-gold/35';
			case 'failed':
				return 'bg-red-50 text-red-700 border-red-200';
			case 'skipped':
				return 'bg-ink/5 text-faded border-ink/10';
			default:
				return 'bg-ink/5 text-ink-soft border-ink/10';
		}
	}

	function marker(status: Status): string {
		switch (status) {
			case 'done':
				return '✓';
			case 'running':
				return '•';
			case 'waiting':
				return '◷';
			case 'failed':
				return '!';
			case 'skipped':
				return '–';
			default:
				return '';
		}
	}

	let doneCount = $derived(
		data.steps.filter((s) => ['done', 'skipped'].includes(setup.steps[s.id as StepId].status))
			.length
	);
</script>

<svelte:head><title>Set up · Sole</title></svelte:head>

<div class="mx-auto max-w-3xl px-6 py-12">
	<p class="text-accent text-xs font-bold tracking-[0.2em] uppercase">First run</p>
	<h1 class="font-display mt-2 text-4xl font-black">Let's set up your library</h1>
	<p class="text-ink-soft mt-3 max-w-xl text-sm">
		This walks the whole pipeline once: connect to Music Assistant, index your tracks, wait for the
		audio worker to analyse them, then group everything into named vibes. It is safe to close this
		page — the work continues on the server.
	</p>

	{#if setup.complete}
		<div class="border-moss/30 bg-moss/5 mt-8 rounded-2xl border p-5">
			<h2 class="font-display text-lg font-bold">You're set up</h2>
			<p class="text-ink-soft mt-1 text-sm">
				{doneCount} of {data.steps.length} steps finished. Your vibes are ready to browse and play.
			</p>
			<div class="mt-4 flex flex-wrap gap-2">
				<a class="bg-ink text-cream rounded-lg px-4 py-2 text-sm font-bold" href="/vibe"
					>Open your vibes</a
				>
				<a class="border-ink/20 rounded-lg border px-4 py-2 text-sm font-bold" href="/recommend"
					>Get a recommendation</a
				>
				<a class="text-accent-deep px-2 py-2 text-sm font-bold" href="/manage">Library upkeep</a>
			</div>
		</div>
	{/if}

	{#if setup.k && !setup.complete}
		<div class="border-ink/10 mt-8 rounded-2xl border bg-white/70 p-5">
			<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<h2 class="font-display text-lg font-bold">
					{setup.k.k} vibes for {setup.k.clusterable.toLocaleString()} tracks
				</h2>
				<span class="text-faded text-sm">
					~{setup.k.meanPerCluster.toLocaleString()} tracks each
				</span>
			</div>
			<p class="text-ink-soft mt-2 text-sm">{setup.k.explanation}</p>
			<details class="mt-3">
				<summary class="text-accent-deep cursor-pointer text-sm font-bold">
					Why we can't work this out from your music
				</summary>
				<p class="text-ink-soft mt-2 text-sm">
					We measured it rather than guessing. The usual methods all come back flat on centred audio
					embeddings:
				</p>
				<ul class="text-ink-soft mt-2 list-disc space-y-1 pl-5 text-sm">
					<li>
						The elbow in the "how tight are the clusters" curve never plateaus — it just decays, so
						any knee you pick is an artifact of the maths.
					</li>
					<li>
						Silhouette scores negative at every k from 8 to 192, because these clusters are wedges
						of a sphere rather than tight blobs.
					</li>
					<li>
						A two-means split test finds no cluster worth splitting at any k from 4 to 96. The space
						is one smooth cloud.
					</li>
				</ul>
				<p class="text-ink-soft mt-2 text-sm">
					What <em>is</em> real is that the clusters end up genuinely distinct from one another, so k
					is really a choice about how finely to slice. That's why it's a logarithm of your library size
					and capped so no vibe is too small to name or play from.
				</p>
			</details>
		</div>
	{/if}

	<ol class="mt-8 space-y-3">
		{#each data.steps as step (step.id)}
			{@const s = setup.steps[step.id as StepId]}
			<li
				class="border-ink/10 rounded-2xl border bg-white/70 p-4 transition
					{step.id === setup.current ? 'border-accent/40' : ''}"
			>
				<div class="flex flex-wrap items-start justify-between gap-3">
					<div class="min-w-0 flex-1">
						<h3 class="font-bold">{step.title}</h3>
						<p class="text-ink-soft mt-0.5 text-sm">{step.blurb}</p>
						<p
							class="mt-2 text-sm
								{s.status === 'failed' ? 'text-red-700' : ''}
								{s.status === 'pending' ? 'text-faded' : 'text-ink-soft'}"
						>
							{s.detail}
						</p>
					</div>
					<span
						class="flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold {pill(
							s.status
						)}"
					>
						<span class={s.status === 'running' ? 'animate-pulse' : ''}>{marker(s.status)}</span>
						{STATUS_TEXT[s.status]}
					</span>
				</div>
				{#if s.status === 'failed' || s.status === 'skipped'}
					<button
						class="border-ink/20 hover:bg-ink/5 mt-3 cursor-pointer rounded-lg border px-3 py-1.5 text-xs font-bold disabled:opacity-50"
						disabled={retrying !== null || setup.running}
						onclick={() => retry(step.id as StepId)}
					>
						{retrying === step.id ? 'Re-running…' : 'Run this step again'}
					</button>
				{/if}
			</li>
		{/each}
	</ol>

	<div class="mt-8 flex flex-wrap items-center gap-3">
		<button
			class="bg-ink text-cream hover:bg-ink-soft cursor-pointer rounded-lg px-5 py-2.5 font-bold transition disabled:opacity-50"
			disabled={busy || setup.running}
			onclick={start}
		>
			{#if setup.running}
				Setting up…
			{:else if setup.paused}
				Check again
			{:else if setup.startedAt}
				Continue setup
			{:else}
				Start setup
			{/if}
		</button>
		{#if setup.paused}
			<p class="text-ink-soft text-sm">
				Paused while the audio worker catches up. This picks itself back up.
			</p>
		{/if}
	</div>
</div>
