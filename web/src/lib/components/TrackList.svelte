<script lang="ts">
	type Track = {
		uri?: string | null;
		name: string;
		artists: string[];
		album?: string;
		note?: string;
		queueItemId?: string | null;
	};

	let {
		tracks,
		emptyText = 'Nothing here yet.',
		onPlay = null,
		onLike = null,
		onJump = null
	}: {
		tracks: Track[];
		emptyText?: string;
		/** When provided, each row with a uri gets a play button. */
		onPlay?: ((uri: string) => void | Promise<void>) | null;
		/** When provided, each row with a uri gets a like button. */
		onLike?: ((uri: string) => void | Promise<unknown>) | null;
		/** When provided, rows with a queue item id can be played in place. */
		onJump?: ((track: Track) => void | Promise<unknown>) | null;
	} = $props();

	let jumpingKey = $state<string | null>(null);

	function trackKey(track: Track, index: number): string {
		return track.queueItemId ?? track.uri ?? `track-${index}`;
	}

	async function jumpToTrack(track: Track, key: string) {
		if (!onJump || jumpingKey !== null) return;
		jumpingKey = key;
		try {
			await onJump(track);
		} finally {
			jumpingKey = null;
		}
	}
</script>

{#if tracks.length === 0}
	<p class="rounded-2xl border border-dashed border-ink/20 bg-cream/60 px-6 py-8 text-center text-sm text-faded">{emptyText}</p>
{:else}
	<ol>
		{#each tracks as t, i (trackKey(t, i))}
			<li
				class="group flex items-center gap-4 border-b border-ink/10 py-3 transition-colors last:border-0 hover:bg-cream/70"
			>
				<span class="w-8 shrink-0 font-display text-lg font-light text-faded italic tabular-nums group-hover:text-accent">
					{String(i + 1).padStart(2, '0')}
				</span>
				<div class="min-w-0 flex-1">
					<p class="truncate font-bold">{t.name}</p>
					<p class="truncate text-sm text-ink-soft">{t.artists.join(', ')}</p>
					{#if t.note}
						<p class="truncate text-xs text-faded">{t.note}</p>
					{/if}
				</div>
				{#if t.album}
					<p class="hidden max-w-48 truncate text-xs text-faded italic sm:block">{t.album}</p>
				{/if}
				<div class="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
					{#if onPlay && t.uri}
						<button
							class="rounded-full bg-ink/5 px-3 py-1.5 text-xs font-bold text-ink-soft transition hover:bg-accent hover:text-cream"
							onclick={() => onPlay(t.uri as string)}
							title="Play {t.name} now"
						>
							▶ Play
						</button>
					{/if}
					{#if onJump && t.queueItemId}
						<button
							class="rounded-full bg-accent/10 px-3 py-1.5 text-xs font-bold text-accent-deep transition hover:bg-accent hover:text-cream disabled:cursor-wait disabled:opacity-50"
							disabled={jumpingKey !== null}
							onclick={() => jumpToTrack(t, trackKey(t, i))}
							title="Jump to {t.name}"
						>
							{jumpingKey === trackKey(t, i) ? 'Starting…' : '▶ Play now'}
						</button>
					{/if}
					{#if onLike && t.uri}
						<button
							class="rounded-full bg-moss/10 px-3 py-1.5 text-xs font-bold text-moss transition hover:bg-moss hover:text-cream"
							onclick={() => onLike(t.uri as string)}
							title="Like {t.name}"
						>
							♥ Like
						</button>
					{/if}
				</div>
			</li>
		{/each}
	</ol>
{/if}
