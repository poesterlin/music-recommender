<script lang="ts">
	import { untrack } from 'svelte';
	import { post } from '$lib/api';
	import { toastStore } from '$lib/client/toast.svelte';
	import type { SetupState, StepId, StepStatus } from '$lib/server/setup/state';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	let setup = $state<SetupState>(untrack(() => data.state));
	let busy = $state(false);
	const actions: Partial<Record<StepId, string>> = {
		environment: 'Check database',
		library: 'Refresh Music Assistant',
		index: 'Index library',
		cluster: 'Create vibes',
		name: 'Auto-name missing vibes'
	};
	const labels: Record<StepStatus, string> = {
		pending: 'Ready',
		running: 'Working',
		waiting: 'Waiting',
		done: 'Ready',
		failed: 'Needs attention',
		skipped: 'Optional'
	};
	let waiting = $derived(Object.values(setup.steps).some((step) => step.status === 'waiting'));

	async function refresh() {
		const response = await fetch('/api/setup');
		if (response.ok) setup = (await response.json()).state;
	}

	$effect(() => {
		if (!setup.running && !waiting) return;
		const timer = setInterval(() => {
			void refresh().catch(() => undefined);
		}, 4000);
		return () => clearInterval(timer);
	});

	async function run(step: StepId) {
		busy = true;
		try {
			const result = await post<{ state: SetupState }>('/api/setup/run', { step });
			if (result.ok) setup = result.data.state;
			else toastStore.show('That action could not be started');
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>Set up · Sole</title></svelte:head>

<div class="mx-auto max-w-3xl px-6 py-12">
	<p class="text-accent text-xs font-bold tracking-[0.2em] uppercase">Library readiness</p>
	<h1 class="font-display mt-2 text-4xl font-black">Set up your library</h1>
	<p class="text-ink-soft mt-3 max-w-xl text-sm">
		This checklist reflects your library now. Run the actions you need; audio analysis runs in the
		worker. Existing vibes and names are preserved.
	</p>

	{#if setup.complete}
		<div class="border-moss/30 bg-moss/5 mt-8 rounded-2xl border p-5">
			<h2 class="font-display text-lg font-bold">Your library is ready</h2>
			<a
				class="bg-ink text-cream mt-4 inline-block rounded-lg px-4 py-2 text-sm font-bold"
				href="/vibe">Open your vibes</a
			>
		</div>
	{/if}

	{#if setup.k}
		<div class="border-ink/10 mt-8 rounded-2xl border bg-white/70 p-5">
			<h2 class="font-display text-lg font-bold">{setup.k.k} suggested vibes</h2>
			<p class="text-ink-soft mt-2 text-sm">{setup.k.explanation}</p>
		</div>
	{/if}

	<ol class="mt-8 space-y-3">
		{#each data.steps as step (step.id)}
			{@const state = setup.steps[step.id]}
			<li class="border-ink/10 rounded-2xl border bg-white/70 p-4">
				<div class="flex items-start justify-between gap-3">
					<div>
						<h2 class="font-bold">{step.title}</h2>
						<p class="text-ink-soft mt-1 text-sm">{step.blurb}</p>
						<p class="mt-2 text-sm {state.status === 'failed' ? 'text-red-700' : 'text-ink-soft'}">
							{state.detail}
						</p>
					</div>
					<span class="text-faded shrink-0 text-xs font-bold">{labels[state.status]}</span>
				</div>
				{#if actions[step.id] && !(step.id === 'cluster' && state.status === 'done')}
					<button
						class="border-ink/20 hover:bg-ink/5 mt-3 cursor-pointer rounded-lg border px-3 py-1.5 text-sm font-bold disabled:opacity-50"
						disabled={busy ||
							setup.running ||
							(step.id === 'cluster' && setup.steps.embed.status !== 'done')}
						onclick={() => run(step.id)}
						>{setup.current === step.id ? 'Working…' : actions[step.id]}</button
					>
				{/if}
				{#if step.id === 'embed'}
					<a class="text-accent-deep mt-3 inline-block text-sm font-bold" href="/status"
						>View worker progress</a
					>
				{/if}
			</li>
		{/each}
	</ol>

	<button
		class="border-ink/20 mt-8 cursor-pointer rounded-lg border px-4 py-2 text-sm font-bold"
		onclick={() => refresh().catch(() => toastStore.show('Could not refresh readiness'))}
		>Refresh checklist</button
	>
</div>
