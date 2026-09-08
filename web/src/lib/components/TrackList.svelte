<script lang="ts">
	let {
		tracks,
		emptyText = 'Nothing here yet.'
	}: {
		tracks: { uri?: string; name: string; artists: string[]; album?: string }[];
		emptyText?: string;
	} = $props();
</script>

{#if tracks.length === 0}
	<p class="rounded-2xl border border-dashed border-ink/20 bg-cream/60 px-6 py-8 text-center text-sm text-faded">{emptyText}</p>
{:else}
	<ol>
		{#each tracks as t, i (t.uri ?? i)}
			<li
				class="group flex items-baseline gap-4 border-b border-ink/10 py-3 transition-colors last:border-0 hover:bg-cream/70"
			>
				<span class="w-8 shrink-0 font-display text-lg font-light text-faded italic tabular-nums group-hover:text-accent">
					{String(i + 1).padStart(2, '0')}
				</span>
				<div class="min-w-0 flex-1">
					<p class="truncate font-bold">{t.name}</p>
					<p class="truncate text-sm text-ink-soft">{t.artists.join(', ')}</p>
				</div>
				{#if t.album}
					<p class="hidden max-w-48 truncate text-xs text-faded italic sm:block">{t.album}</p>
				{/if}
			</li>
		{/each}
	</ol>
{/if}
