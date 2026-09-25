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
	<p
		class="border-ink/20 bg-cream/60 text-faded rounded-2xl border border-dashed px-6 py-8 text-center text-sm"
	>
		{emptyText}
	</p>
{:else}
	<ol>
		{#each tracks as t, i (trackKey(t, i))}
			{@const key = trackKey(t, i)}
			<li
				class="group border-ink/10 hover:bg-cream/70 flex items-center gap-4 border-b py-3 transition-colors last:border-0"
			>
				{#if hasPlayAction(t)}
					<div class="relative flex size-8 shrink-0 items-center justify-center">
						<span
							class="font-display text-faded group-hover:text-accent hidden text-lg font-light italic tabular-nums transition duration-200 ease-out sm:block sm:translate-y-0 sm:opacity-100 sm:group-focus-within:translate-y-0 sm:group-focus-within:opacity-0 sm:group-hover:-translate-y-0.5 sm:group-hover:opacity-0"
						>
							{String(i + 1).padStart(2, '0')}
						</span>
						<button
							class="bg-accent text-cream shadow-accent/20 hover:bg-accent-deep focus-visible:ring-accent/50 absolute inset-0 flex size-8 items-center justify-center rounded-full text-sm shadow-md transition duration-200 ease-out hover:scale-105 focus-visible:ring-2 focus-visible:outline-none disabled:cursor-wait disabled:opacity-50 sm:scale-90 sm:opacity-0 sm:group-focus-within:scale-100 sm:group-focus-within:opacity-100 sm:group-hover:scale-100 sm:group-hover:opacity-100"
							disabled={playingKey !== null}
							onclick={() => playTrack(t, key)}
							aria-label="Play {t.name} now"
							title="Play {t.name} now"
						>
							{playingKey === key ? '…' : '▶'}
						</button>
					</div>
				{:else}
					<span
						class="font-display text-faded group-hover:text-accent w-8 shrink-0 text-lg font-light italic tabular-nums"
					>
						{String(i + 1).padStart(2, '0')}
					</span>
				{/if}
				<div class="min-w-0 flex-1">
					<p class="truncate font-bold">{t.name}</p>
					<p class="text-ink-soft truncate text-sm">{t.artists.join(', ')}</p>
					{#if t.note}
						<p class="text-faded truncate text-xs">{t.note}</p>
					{/if}
				</div>
				{#if t.album}
					<p class="text-faded hidden max-w-48 truncate text-xs italic sm:block">{t.album}</p>
				{/if}
				{#if onLike && t.uri}
					<button
						class="bg-moss/10 text-moss hover:bg-moss hover:text-cream shrink-0 rounded-full px-3 py-1.5 text-xs font-bold transition"
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
