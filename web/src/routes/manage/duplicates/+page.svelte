<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import { IconAlertTriangle, IconCopy, IconRestore } from '@tabler/icons-svelte';
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
	};
	type Group = {
		key: string;
		name: string;
		album: string;
		artist: string;
		keeper: Copy;
		victims: Copy[];
		clusters: number[];
	};
	type Summary = {
		groups: Group[];
		groupCount: number;
		duplicateCount: number;
		alreadySkipped: number;
		pendingCount: number;
		losslyEmbeddedKept: boolean;
	};

	let summary = $state<Summary | null>(null);
	let loading = $state(true);
	let working = $state(false);
	let expanded = new SvelteSet<string>();
	let selection = new SvelteSet<string>();

	async function load() {
		loading = true;
		const { ok, data } = await api<Summary>('/api/duplicates?limit=200');
		summary = ok ? data : null;
		loading = false;
	}

	$effect(() => {
		void load();
	});

	const allSelected = $derived(
		summary !== null &&
			summary.groups.length > 0 &&
			summary.groups.every((g) => selection.has(g.key))
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
		selection = on
			? new SvelteSet((summary?.groups ?? []).map((g) => g.key))
			: new SvelteSet<string>();
	}

	async function act(action: 'skip' | 'restore') {
		if (selection.size === 0) {
			toastStore.show('Select at least one group');
			return;
		}
		const count = selection.size;
		if (
			action === 'skip' &&
			!confirm(
				`Skip the duplicate copies in ${count} group${count === 1 ? '' : 's'}?\n\n` +
					`Skipped tracks are excluded from recommendations and clustering. ` +
					`This can be undone here.`
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
			toastStore.show(`${action === 'skip' ? 'Skipped' : 'Restored'} ${data.affected ?? 0} tracks`);
			selection = new SvelteSet<string>();
			await load();
		}
	}
</script>

<PageHeader
	kicker="Manage"
	title="Duplicates"
	description="The same track and album imported more than once. The embedded copy is kept; the rest are skipped, which excludes them from recommendations and clustering."
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
		Rescan
	</button>
</div>

{#if loading}
	<p class="text-faded py-8 text-center text-sm">Scanning for duplicates…</p>
{:else if !summary || summary.groupCount === 0}
	<p
		class="border-ink/15 text-faded rounded-2xl border border-dashed px-6 py-10 text-center text-sm"
	>
		No duplicate track and album combinations found.
	</p>
{:else}
	<div class="border-ink/10 bg-cream rounded-2xl border p-5">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="grid gap-1 sm:grid-cols-3 sm:gap-6">
				<div>
					<p class="text-faded text-xs font-bold tracking-wide uppercase">Groups</p>
					<p class="font-display text-2xl font-black">{summary.groupCount.toLocaleString()}</p>
				</div>
				<div>
					<p class="text-faded text-xs font-bold tracking-wide uppercase">Duplicate copies</p>
					<p class="font-display text-2xl font-black">{summary.duplicateCount.toLocaleString()}</p>
				</div>
				<div>
					<p class="text-faded text-xs font-bold tracking-wide uppercase">Still active</p>
					<p class="font-display text-2xl font-black">{summary.pendingCount.toLocaleString()}</p>
				</div>
			</div>
			<div class="flex flex-wrap gap-2">
				<button
					class="border-ink/20 text-ink-soft hover:bg-ink/5 rounded-lg px-3 py-2 text-sm font-bold transition"
					onclick={() => selectAll(!allSelected)}
				>
					{allSelected ? 'Clear selection' : 'Select all shown'}
				</button>
				<button
					class="bg-accent text-cream hover:bg-accent-deep inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-bold transition disabled:opacity-50"
					disabled={working || selection.size === 0}
					onclick={() => act('skip')}
				>
					<IconCopy size={15} />
					Skip {selection.size || ''} selected
				</button>
				<button
					class="border-ink/20 text-ink-soft hover:bg-ink/5 inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-bold transition disabled:opacity-50"
					disabled={working || selection.size === 0}
					onclick={() => act('restore')}
				>
					<IconRestore size={15} />
					Restore
				</button>
			</div>
		</div>

		{#if !summary.losslyEmbeddedKept}
			<p class="mt-4 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
				<IconAlertTriangle size={16} class="mt-0.5 shrink-0" />
				Some duplicates carry an embedding the kept copy does not. Skipping them discards that work.
			</p>
		{/if}

		<p class="text-faded mt-4 text-xs">
			Showing the {summary.groups.length.toLocaleString()} largest of
			{summary.groupCount.toLocaleString()} groups. Skipped copies stay skipped when the library is re-indexed.
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
							{group.victims.length} duplicate{group.victims.length === 1 ? '' : 's'}
						</p>
						{#if group.clusters.length > 1}
							<p class="text-accent-deep font-bold">
								split across {group.clusters.length} clusters
							</p>
						{:else}
							<p class="text-faded">cluster {group.clusters[0] ?? '—'}</p>
						{/if}
					</div>
					<span class="text-faded text-xs tabular-nums"
						>{group.victims.filter((v) => v.skipped).length}/{group.victims.length} skipped</span
					>
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
									Duplicate {victim.skipped ? '· skipped' : ''}
								</p>
								<p class="mt-1 truncate font-bold">{victim.name}</p>
								<p class="text-faded mt-0.5 truncate text-xs">
									{victim.uri.replace('library://track/', '#')}
									{#if victim.embedded}· embedded{/if}
								</p>
							</div>
						{/each}
					</div>
				{/if}
			</li>
		{/each}
	</ul>
{/if}
