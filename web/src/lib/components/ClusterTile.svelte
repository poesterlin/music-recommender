<script lang="ts">
	import { IconMusic, IconPencil, IconPlayerPlayFilled } from '@tabler/icons-svelte';
	import { coverUrl } from '$lib/cover-image';

	let {
		clusterId,
		name,
		trackCount,
		covers,
		named = false,
		selected = false,
		playing = false,
		playable = false,
		disabled = false,
		onselect,
		onpreview
	}: {
		clusterId: number;
		name: string;
		trackCount?: number | null;
		covers: { primary: string | null; secondary: string | null };
		/** True when a human has named this cluster. */
		named?: boolean;
		selected?: boolean;
		/** True while a sample from this cluster is playing. */
		playing?: boolean;
		/** Home shelf tiles start playback instead of opening the name editor. */
		playable?: boolean;
		disabled?: boolean;
		onselect: (clusterId: number) => void;
		onpreview?: (clusterId: number) => void;
	} = $props();

	const primary = $derived(coverUrl(covers.primary, 256));
	const secondary = $derived(coverUrl(covers.secondary, 256));
	// While a sample plays the record turns at speed; otherwise it only creeps
	// when revealed, so a grid of 51 tiles is not a wall of spinning discs.
	const turn = $derived(playing ? 'animate-vinyl' : 'group-hover:animate-vinyl-idle');
</script>

<button
	type="button"
	class="group relative block w-full cursor-pointer text-left [perspective:900px]"
	onclick={() => onselect(clusterId)}
	{disabled}
	aria-label={playable ? `Play ${name}` : undefined}
	aria-pressed={playable ? undefined : selected}
>
	<!--
		One object, not two. The cover and the label are a single card with a fold
		between them, the way a J-card sleeve opens to show its track listing. They
		used to sit in a gap and lift independently, which read as a card and a
		caption floating apart rather than as one thing you could pick up.
	-->
	<div
		class="relative overflow-hidden rounded-xl border transition-all duration-300 ease-out
			group-hover:-translate-y-1.5 group-hover:rotate-[-1.1deg] group-hover:shadow-[0_18px_30px_-12px_rgba(29,21,14,0.55)]
			group-active:translate-y-0 group-active:scale-[0.985] group-active:shadow-[0_4px_10px_-6px_rgba(29,21,14,0.5)]
			{selected
			? 'border-accent ring-accent/40 shadow-lg ring-2'
			: 'border-ink/15 shadow-[0_6px_14px_-8px_rgba(29,21,14,0.5)]'}"
	>
		<!-- Cover. Clipped to its own square so the record cannot escape downward. -->
		<div class="bg-line/40 relative aspect-square w-full overflow-hidden">
			<!--
				The record, built from three nested elements on purpose. Centring,
				sliding out of the sleeve, and spinning all write `transform`, so each
				owns its own element: one element cannot do two of them at once. It
				also means no element carries two competing translate utilities, whose
				precedence Tailwind decides by its own sort order rather than by the
				order they appear in the attribute.
			-->
			<div class="pointer-events-none absolute inset-0 z-0 flex items-center justify-center">
				<div
					class="relative aspect-square w-[86%] transition-transform duration-500 ease-out
						group-hover:translate-x-[34%] {playing ? 'translate-x-[34%]' : ''}"
				>
					<div
						class="relative size-full rounded-full opacity-0 transition-opacity duration-300
						group-hover:opacity-100 {playing ? 'opacity-100' : ''} {turn} motion-reduce:animate-none"
					>
						<!-- Grooves: tight concentric rings, the thing that reads as "vinyl". -->
						<div
							class="absolute inset-0 rounded-full
							bg-[repeating-radial-gradient(circle_at_center,#171009_0_1.5px,#2c2117_1.5px_3px)]
							shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07),inset_0_0_26px_rgba(0,0,0,0.85)]"
						></div>
						<!--
						Light orbiting with the disc. Because it lives inside the spinning
						element, the highlight travels around the record and sells the
						rotation far better than moving grooves alone.
					-->
						<div
							class="absolute inset-0 rounded-full
							bg-[conic-gradient(from_0deg,rgba(255,255,255,0.16)_0deg,rgba(255,255,255,0)_55deg,rgba(255,255,255,0)_180deg,rgba(255,255,255,0.13)_205deg,rgba(255,255,255,0)_260deg,rgba(255,255,255,0)_360deg)]"
						></div>
						<!-- Raised paper label, bevelled like a pasted centre. -->
						<div
							class="absolute inset-[36%] rounded-full bg-[#e8490f] shadow-[inset_0_1px_0_rgba(255,255,255,0.35),inset_0_-2px_4px_rgba(120,30,4,0.55),0_0_0_1px_rgba(29,21,14,0.45)]"
						>
							<!-- Spindle hole. Small, but it is the detail that says "record". -->
							<div
								class="absolute inset-[42%] rounded-full bg-[#0d0906] shadow-[inset_0_1px_2px_rgba(0,0,0,0.9)]"
							></div>
						</div>
					</div>
				</div>
			</div>

			<!-- Artwork sits in front; it slides left on hover to reveal the record. -->
			{#if primary}
				<img
					src={primary}
					alt=""
					loading="lazy"
					class="relative z-10 size-full object-cover shadow-[0_2px_8px_rgba(0,0,0,0.35)]
					transition-transform duration-500 ease-out group-hover:-translate-x-[12%] group-hover:scale-[1.06]"
				/>
			{:else}
				<div class="text-faded bg-cream/70 absolute inset-0 z-10 flex items-center justify-center">
					<IconMusic size={44} stroke={1} />
				</div>
			{/if}

			{#if secondary}
				<img
					src={secondary}
					alt=""
					loading="lazy"
					class="border-cream absolute right-1.5 bottom-1.5 z-20 size-1/4 rounded-md border-2 object-cover shadow-[0_4px_10px_rgba(0,0,0,0.45)]
					transition-transform duration-500 ease-out group-hover:-translate-y-1 group-hover:scale-105"
				/>
			{/if}

			<!-- Glossy sheen across the sleeve, as on a shrink-wrapped record. -->
			<div
				class="pointer-events-none absolute inset-0 z-30 bg-[linear-gradient(115deg,rgba(255,255,255,0.22)_0%,rgba(255,255,255,0)_42%,rgba(0,0,0,0.12)_100%)]"
			></div>

			<!--
				Spine highlight down the leading edge, so the sleeve reads as card
				with thickness rather than a flat image.
			-->
			<div
				class="pointer-events-none absolute inset-y-0 left-0 z-30 w-[7px] bg-[linear-gradient(90deg,rgba(255,255,255,0.30),rgba(255,255,255,0)_78%)]"
			></div>
			<!-- Light from above, and wear along the bottom edge. -->
			<div
				class="pointer-events-none absolute inset-0 z-30 shadow-[inset_0_1px_0_rgba(255,255,255,0.28),inset_0_-2px_6px_rgba(29,21,14,0.22)]"
			></div>

			{#if named}
				<span
					class="bg-moss text-cream absolute top-1.5 left-1.5 z-40 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase shadow"
				>
					Named
				</span>
			{/if}

			{#if playing}
				<!-- Equaliser bars, so a playing tile is obvious in a grid of 51. -->
				<div
					class="absolute top-1.5 right-1.5 z-40 flex h-4 items-end gap-[2px]"
					aria-hidden="true"
				>
					{#each [0, 1, 2, 3] as bar (bar)}
						<!--
							The class supplies the keyframes; the inline style only staggers
							each bar. Naming the animation inline instead leaves Tailwind with
							no reference to the utility, and it drops the keyframes.
						-->
						<span
							class="bg-accent animate-vinyl-pulse w-[3px] origin-bottom rounded-sm motion-reduce:animate-none"
							style="height: {45 + ((bar * 37) % 55)}%; animation-duration: {0.5 +
								bar * 0.19}s; animation-delay: {bar * 0.11}s"
						></span>
					{/each}
				</div>
			{/if}
		</div>

		<!--
			The fold. A dark crease with a lit edge below it, so the label reads as
			the other panel of the same card rather than a separate box tucked
			underneath.
		-->
		<div
			class="pointer-events-none relative z-20 h-[3px] shrink-0 bg-[linear-gradient(180deg,rgba(29,21,14,0.34)_0%,rgba(29,21,14,0.10)_55%,rgba(255,255,255,0.45)_100%)]"
		></div>

		<!-- Label panel, hinged to the cover. -->
		<div class="bg-cream relative px-2.5 pt-2 pb-2">
			<!-- Shadow the cover casts down onto the label. -->
			<div
				class="pointer-events-none absolute inset-x-0 top-0 h-2.5 bg-[linear-gradient(180deg,rgba(29,21,14,0.20),rgba(29,21,14,0))]"
			></div>
			<div class="relative flex items-baseline gap-1.5">
				<span class="text-faded font-mono text-[11px]">#{clusterId}</span>
				{#if !named && !playable}
					<IconPencil size={11} class="text-faded opacity-0 transition group-hover:opacity-100" />
				{/if}
			</div>
			<p class="font-display relative text-[13px] leading-snug font-black">{name}</p>
			<div class="relative mt-1.5 flex items-center justify-between gap-2">
				{#if trackCount}
					<span class="text-faded inline-flex items-center gap-1 text-[11px] tabular-nums">
						<IconMusic size={11} />
						{new Intl.NumberFormat().format(trackCount)}
					</span>
				{:else}
					<span></span>
				{/if}
				{#if playable}
					<span class="text-accent-deep inline-flex items-center gap-1 text-[11px] font-bold"
						><IconPlayerPlayFilled size={11} /> {selected ? 'Starting…' : 'Play'}</span
					>
				{:else if onpreview}
					<span
						role="button"
						tabindex="0"
						class="text-faded hover:bg-ink/5 hover:text-ink inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-bold transition"
						onclick={(e) => {
							e.stopPropagation();
							onpreview(clusterId);
						}}
						onkeydown={(e) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								e.stopPropagation();
								onpreview(clusterId);
							}
						}}
						aria-label="Preview a sample from cluster {clusterId}"
					>
						<IconPlayerPlayFilled size={11} />
						Preview
					</span>
				{/if}
			</div>
		</div>
	</div>
</button>
