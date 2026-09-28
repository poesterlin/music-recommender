<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { IconAlertTriangle, IconBolt, IconCopy, IconRestore } from '@tabler/icons-svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { toastStore } from '$lib/client/toast.svelte';
	import { api } from '$lib/api';

	type Copy = {
		uri: string;
		name: string;
		album: string;
		artists: string[];
		clusterId: number | null;
		embedded: boolean;
		skipped: boolean;
		createdAt: string | null;
		similarity: number | null;
	};
	type Group = {
		key: string;
		name: string;
		album: string;
		artist: string;
		keeper: Copy;
		victims: Copy[];
		clusters: number[];
		similarity: number | null;
		mixedAudio: boolean;
	};
	type Summary = {
		groups: Group[];
		groupCount: number;
		duplicateCount: number;
		alreadySkipped: number;
		pendingCount: number;
		mixedAudioGroups: number;
	};

	let summary = $state<Summary | null>(null);
	let loading = $state(true);
	let working = $state(false);
	let expanded = new SvelteSet<string>();
	let selection = $state(new SvelteSet<string>());

	// Bulk state. The plan is fetched up front so the confirmation quotes
	// exact numbers rather than an estimate.
	let bulk = $state<{ groups: number; copies: number } | null>(null);
	let bulkProgress = $state<{ affected: number; done: boolean } | null>(null);

	async function load() {
		loading = true;
		const [scan, plan] = await Promise.all([
			api<Summary>('/api/duplicates?limit=200'),
			api<{ groups: number; copies: number }>('/api/duplicates/bulk', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'plan' })
			})
		]);
		summary = scan.ok ? scan.data : null;
		bulk = plan.ok ? plan.data : null;
		// Preselect only groups that still have work to do. Fully-skipped
		// groups and groups whose copies sound different are a judgement call,
		// so they start unselected and a bulk skip cannot quietly drop tracks.
		if (scan.ok) {
			selection = new SvelteSet(
				scan.data.groups
					.filter((g) => !g.mixedAudio && g.victims.some((v) => !v.skipped))
					.map((g) => g.key)
			);
		}
		loading = false;
	}

	/**
	 * Prune every unambiguous group in bounded server-side batches.
	 *
	 * Paging 200 groups at a time through the browser would take over a hundred
	 * rounds on a library this size, so the server derives the keeper and
	 * victim sets itself. Each call is idempotent, so a run that is interrupted
	 * can simply be repeated.
	 */
	async function pruneAllSafe() {
		if (!bulk) return;
		if (
			!confirm(
				`Skip extra copies in ${bulk.groups.toLocaleString()} likely matching group${bulk.groups === 1 ? '' : 's'}?\n\n` +
					`One copy stays available in each group. Music files are not deleted, and you can undo this here.`
			)
		) {
			return;
		}
		working = true;
		bulkProgress = { affected: 0, done: false };
		let guard = 0;
		while (!bulkProgress.done && guard < 200) {
			guard += 1;
			const { ok, data } = await api<{
				affected?: number;
				done?: boolean;
				error?: string;
			}>('/api/duplicates/bulk', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ action: 'prune', limit: 4000 })
			});
			if (!ok) {
				toastStore.show(data.error ?? 'Could not skip the matches');
				break;
			}
			bulkProgress = {
				affected: (bulkProgress?.affected ?? 0) + (data.affected ?? 0),
				done: data.done !== false
			};
		}
		working = false;
		if (bulkProgress?.done) {
			toastStore.show('Finished skipping likely matches');
			bulkProgress = null;
			await load();
		}
	}

	$effect(() => {
		void load();
	});

	const selectable = $derived((summary?.groups ?? []).filter((g) => !g.mixedAudio));
	const shownPending = $derived(
		(summary?.groups ?? []).reduce(
			(total, group) => total + group.victims.filter((copy) => !copy.skipped).length,
			0
		)
	);
	const selectedPending = $derived(
		(summary?.groups ?? []).reduce(
			(total, group) =>
				total +
				(selection.has(group.key) ? group.victims.filter((copy) => !copy.skipped).length : 0),
			0
		)
	);
	const allSelected = $derived(
		selectable.length > 0 && selectable.every((g) => selection.has(g.key))
	);

	function toggle(key: string) {
		if (selection.has(key)) selection.delete(key);
		else selection.add(key);
	}

	function toggleGroup(key: string) {
		if (expanded.has(key)) expanded.delete(key);
		else expanded.add(key);
	}

	function selectAll(on: boolean) {
		selection = on ? new SvelteSet(selectable.map((g) => g.key)) : new SvelteSet<string>();
	}

	async function act(action: 'skip' | 'restore') {
		if (selection.size === 0 || (action === 'skip' && selectedPending === 0)) {
			toastStore.show(
				action === 'skip' ? 'No active copies selected' : 'Select at least one group'
			);
			return;
		}
		const count = selection.size;
		if (
			action === 'skip' &&
			!confirm(
				`Skip the extra copies in ${count} group${count === 1 ? '' : 's'}?\n\n` +
					`One copy stays available in each group. Music files are not deleted, and you can undo this here.`
			)
		) {
			return;
		}
		working = true;
		const { ok, data } = await api<{ affected?: number; error?: string }>('/api/duplicates', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ keys: [...selection], action })
		});
		working = false;
		if (ok) {
			const affected = data.affected ?? 0;
			toastStore.show(
				action === 'skip'
					? 'Selected copies skipped'
					: `Restored ${affected} track${affected === 1 ? '' : 's'}`
			);
			selection = new SvelteSet<string>();
			await load();
		}
	}
</script>

<PageHeader
	kicker="Manage"
	title="Duplicates"
	description="Keep one copy of each song. Skipping extras hides them from recommendations without deleting your music."
/>

<div class="mb-6 flex flex-wrap gap-2">
	<a
		class="border-ink/15 hover:bg-ink/5 rounded-xl border bg-white px-4 py-2 text-sm font-bold"
		href="/manage"
	>
		Back to Manage
	</a>
	<button
		class="border-ink/15 hover:bg-ink/5 rounded-xl border bg-white px-4 py-2 text-sm font-bold disabled:opacity-50"
		disabled={loading}
		onclick={load}
	>
		Refresh results
	</button>
</div>

{#if loading}
	<p class="text-faded py-8 text-center text-sm">Scanning for duplicates…</p>
{:else if !summary || summary.groupCount === 0}
	<p
		class="border-ink/15 text-faded rounded-2xl border border-dashed px-6 py-10 text-center text-sm"
	>
		No matching copies found.
	</p>
{:else}
	<div class="border-ink/10 bg-cream rounded-2xl border p-5">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="grid gap-1 sm:grid-cols-3 sm:gap-6">
				<div>
					<p class="text-faded text-xs font-bold tracking-wide uppercase">Matching groups</p>
					<p class="font-display text-2xl font-black">{summary.groupCount.toLocaleString()}</p>
				</div>
				<div>
					<p class="text-faded text-xs font-bold tracking-wide uppercase">Extra copies</p>
					<p class="font-display text-2xl font-black">{summary.duplicateCount.toLocaleString()}</p>
				</div>
				<div>
					<p class="text-faded text-xs font-bold tracking-wide uppercase">Not skipped yet</p>
					<p class="font-display text-2xl font-black">{summary.pendingCount.toLocaleString()}</p>
				</div>
			</div>
			<div class="flex flex-wrap gap-2">
				{#if bulk && bulk.copies > 0}
					<button
						class="bg-moss text-cream hover:bg-moss/90 inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-bold transition disabled:opacity-50"
						disabled={working}
						onclick={pruneAllSafe}
					>
						<IconBolt size={15} />
						{bulkProgress ? 'Skipping…' : 'Skip likely matches'}
					</button>
				{/if}
				<button
					class="border-ink/20 text-ink-soft hover:bg-ink/5 rounded-lg px-3 py-2 text-sm font-bold transition"
					onclick={() => selectAll(!allSelected)}
				>
					{allSelected ? 'Clear selection' : 'Select all shown'}
				</button>
				<button
					class="bg-accent text-cream hover:bg-accent-deep inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-bold transition disabled:opacity-50"
					disabled={working || selectedPending === 0}
					onclick={() => act('skip')}
				>
					<IconCopy size={15} />
					{selectedPending > 0
						? `Skip ${selectedPending} active cop${selectedPending === 1 ? 'y' : 'ies'}`
						: 'Nothing selected to skip'}
				</button>
				<button
					class="border-ink/20 text-ink-soft hover:bg-ink/5 inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-bold transition disabled:opacity-50"
					disabled={working || selection.size === 0}
					onclick={() => act('restore')}
				>
					<IconRestore size={15} />
					Undo skip
				</button>
			</div>
		</div>

		{#if summary.mixedAudioGroups > 0}
			<p class="mt-4 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
				<IconAlertTriangle size={16} class="mt-0.5 shrink-0" />
				<span>
					{summary.mixedAudioGroups.toLocaleString()} group{summary.mixedAudioGroups === 1
						? ''
						: 's'} may contain different recordings. They are not selected automatically. Review them
					before skipping.
				</span>
			</p>
		{/if}
		<p class="text-ink-soft mt-4 text-sm">
			{#if shownPending === 0}
				The groups shown below are already handled. No need to skip them again.
				{#if summary.pendingCount > 0}
					The {summary.pendingCount.toLocaleString()} unskipped cop{summary.pendingCount === 1
						? 'y'
						: 'ies'} are in other groups.
				{/if}
			{:else}
				{shownPending.toLocaleString()} extra cop{shownPending === 1 ? 'y' : 'ies'} in the groups shown
				below {shownPending === 1 ? 'is' : 'are'} not skipped yet. Select groups to skip their extras,
				or leave different recordings alone.
			{/if}
		</p>

		<p class="text-faded mt-4 text-xs">
			Showing the {summary.groups.length.toLocaleString()} largest groups, not necessarily those needing
			work. Skipping does not delete music files.
		</p>
	</div>

	<ul class="mt-4 space-y-2">
		{#each summary.groups as group (group.key)}
			<li class="border-ink/10 bg-cream rounded-2xl border">
				<div class="flex flex-wrap items-center gap-3 p-4">
					<input
						type="checkbox"
						class="size-4 accent-[var(--color-accent)]"
						checked={selection.has(group.key)}
						onchange={() => toggle(group.key)}
						aria-label="Select {group.name} by {group.artist}"
					/>
					<button class="min-w-0 flex-1 text-left" onclick={() => toggleGroup(group.key)}>
						<p class="truncate font-bold">{group.name}</p>
						<p class="text-ink-soft truncate text-sm">{group.artist} — {group.album}</p>
					</button>
					<div class="text-right text-xs">
						<p class="text-faded">
							{group.victims.length} extra cop{group.victims.length === 1 ? 'y' : 'ies'}
						</p>
						{#if group.mixedAudio}
							<p class="font-bold text-amber-700">Review: may sound different</p>
						{/if}
					</div>
					<span class="text-faded text-xs tabular-nums">
						{group.victims.every((v) => v.skipped)
							? 'All extras skipped'
							: `${group.victims.filter((v) => !v.skipped).length} left to review`}
					</span>
				</div>
				{#if expanded.has(group.key)}
					<div class="border-ink/10 grid gap-2 border-t p-4 sm:grid-cols-2">
						<div class="border-moss/40 bg-moss/5 rounded-xl border p-3">
							<p class="text-moss text-xs font-bold tracking-wide uppercase">Kept</p>
							<p class="mt-1 truncate font-bold">{group.keeper.name}</p>
							<p class="text-faded mt-0.5 truncate text-xs">
								{group.keeper.uri.replace('library://track/', '#')}
								{#if group.keeper.embedded}· embedded{:else}· no embedding{/if}
							</p>
						</div>
						{#each group.victims as victim (victim.uri)}
							<div
								class="border-line rounded-xl border p-3 {victim.skipped
									? 'bg-ink/5 opacity-60'
									: ''}"
							>
								<p class="text-faded text-xs font-bold tracking-wide uppercase">
									Extra copy {victim.skipped ? '· skipped' : ''}
								</p>
								<p class="mt-1 truncate font-bold">{victim.name}</p>
								<p class="text-faded mt-0.5 truncate text-xs">
									{victim.uri.replace('library://track/', '#')}
									{#if victim.embedded}· embedded{/if}
									{#if victim.similarity !== null}· match {victim.similarity.toFixed(3)}{/if}
								</p>
							</div>
						{/each}
					</div>
				{/if}
			</li>
		{/each}
	</ul>
{/if}
