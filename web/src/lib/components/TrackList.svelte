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
		/** When provided, each row with a uri gets a play action. */
		onPlay?: ((uri: string) => void | Promise<void>) | null;
		/** When provided, each row with a uri gets a like button. */
		onLike?: ((uri: string) => void | Promise<unknown>) | null;
		/** When provided, rows with a queue item id can be played in place. */
		onJump?: ((track: Track) => void | Promise<unknown>) | null;
	} = $props();

	let playingKey = $state<string | null>(null);

	function trackKey(track: Track, index: number): string {
		return track.queueItemId ?? track.uri ?? `track-${index}`;
	}

	function hasPlayAction(track: Track): boolean {
		return Boolean((onJump && track.queueItemId) || (onPlay && track.uri));
	}

	async function playTrack(track: Track, key: string) {
		if (playingKey !== null || !hasPlayAction(track)) return;
		playingKey = key;
		try {
			if (onJump && track.queueItemId) {
				await onJump(track);
			} else if (onPlay && track.uri) {
				await onPlay(track.uri);
			}
		} finally {
			playingKey = null;
		}
	}
</script>

{#if tracks.length === 0}
	<p class="rounded-2xl border border-dashed border-ink/20 bg-cream/60 px-6 py-8 text-center text-sm text-faded">{emptyText}</p>
{:else}
	<ol>
		{#each tracks as t, i (trackKey(t, i))}
			{@const key = trackKey(t, i)}
			<li
				class="group flex items-center gap-4 border-b border-ink/10 py-3 transition-colors last:border-0 hover:bg-cream/70"
			>
				{#if hasPlayAction(t)}
					<div class="relative flex size-8 shrink-0 items-center justify-center">
						<span
							class="hidden font-display text-lg font-light text-faded italic tabular-nums transition duration-200 ease-out group-hover:text-accent sm:block sm:translate-y-0 sm:opacity-100 sm:group-focus-within:translate-y-0 sm:group-focus-within:opacity-0 sm:group-hover:-translate-y-0.5 sm:group-hover:opacity-0"
						>
							{String(i + 1).padStart(2, '0')}
						</span>
						<button
							class="absolute inset-0 flex size-8 items-center justify-center rounded-full bg-accent text-sm text-cream shadow-md shadow-accent/20 transition duration-200 ease-out hover:scale-105 hover:bg-accent-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-wait disabled:opacity-50 sm:scale-90 sm:opacity-0 sm:group-focus-within:scale-100 sm:group-focus-within:opacity-100 sm:group-hover:scale-100 sm:group-hover:opacity-100"
							disabled={playingKey !== null}
							onclick={() => playTrack(t, key)}
							aria-label="Play {t.name} now"
							title="Play {t.name} now"
						>
							{playingKey === key ? '…' : '▶'}
						</button>
					</div>
				{:else}
					<span class="w-8 shrink-0 font-display text-lg font-light text-faded italic tabular-nums group-hover:text-accent">
						{String(i + 1).padStart(2, '0')}
					</span>
				{/if}
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
				{#if onLike && t.uri}
					<button
						class="shrink-0 rounded-full bg-moss/10 px-3 py-1.5 text-xs font-bold text-moss transition hover:bg-moss hover:text-cream"
						onclick={() => onLike(t.uri as string)}
						title="Like {t.name}"
					>
						♥ Like
					</button>
				{/if}
			</li>
		{/each}
	</ol>
{/if}
