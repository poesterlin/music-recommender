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
		onselect: (clusterId: number) => void;
		onpreview?: (clusterId: number) => void;
	} = $props();

	const primary = $derived(coverUrl(covers.primary, 256));
	const secondary = $derived(coverUrl(covers.secondary, 256));
</script>

<button
	type="button"
	class="group relative block w-full cursor-pointer text-left [perspective:900px]"
	onclick={() => onselect(clusterId)}
	aria-pressed={selected}
>
	<!-- Sleeve. Lifts and tilts toward the viewer on hover, depresses on press. -->
	<div
		class="relative overflow-hidden rounded-xl border transition-all duration-300 ease-out
			group-hover:-translate-y-1.5 group-hover:rotate-[-1.1deg] group-hover:shadow-[0_18px_30px_-12px_rgba(29,21,14,0.55)]
			group-active:translate-y-0 group-active:scale-[0.985] group-active:shadow-[0_4px_10px_-6px_rgba(29,21,14,0.5)]
			{selected
			? 'border-accent ring-accent/40 shadow-lg ring-2'
			: 'border-ink/15 shadow-[0_6px_14px_-8px_rgba(29,21,14,0.5)]'}"
	>
		<!-- Vinyl sliding out of the sleeve and spinning. Pure CSS, GPU only. -->
		<div
			class="pointer-events-none absolute top-1/2 left-1/2 z-0 aspect-square w-[86%] -translate-x-1/2 -translate-y-1/2 rounded-full
				bg-[repeating-radial-gradient(circle_at_center,#1d150e_0_2px,#3a2c20_2px_3px)]
				opacity-0
				shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] transition-opacity duration-300 group-hover:opacity-100"
			style="transform: translate(-50%,-50%) rotate(0deg); transition: opacity .3s"
		>
			<div
				class="absolute inset-[38%] rounded-full bg-[#e8490f] shadow-[inset_0_0_0_2px_rgba(29,21,14,0.5)] group-hover:animate-[spin_2.4s_linear_infinite]"
			></div>
		</div>

		<!-- Artwork sits in front; it slides right on hover to reveal the record. -->
		<div class="bg-line/40 relative aspect-square w-full overflow-hidden">
			{#if primary}
				<img
					src={primary}
					alt=""
					loading="lazy"
					class="relative z-10 size-full object-cover shadow-[0_2px_8px_rgba(0,0,0,0.35)]
					transition-transform duration-500 ease-out group-hover:translate-x-[14%] group-hover:scale-[1.06]"
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

			{#if named}
				<span
					class="bg-moss text-cream absolute top-1.5 left-1.5 z-40 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase shadow"
				>
					Named
				</span>
			{/if}
		</div>
	</div>

	<!-- Label card below, like the track listing on a sleeve back. -->
	<div
		class="border-ink/10 bg-cream mt-2.5 rounded-lg border px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]
			transition-transform duration-300 ease-out group-hover:-translate-y-1"
	>
		<div class="flex items-baseline gap-1.5">
			<span class="text-faded font-mono text-[11px]">#{clusterId}</span>
			{#if !named}
				<IconPencil size={11} class="text-faded opacity-0 transition group-hover:opacity-100" />
			{/if}
		</div>
		<p class="font-display text-[13px] leading-snug font-black">{name}</p>
		<div class="mt-1.5 flex items-center justify-between gap-2">
			{#if trackCount}
				<span class="text-faded inline-flex items-center gap-1 text-[11px] tabular-nums">
					<IconMusic size={11} />
					{new Intl.NumberFormat().format(trackCount)}
				</span>
			{:else}
				<span></span>
			{/if}
			{#if onpreview}
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
</button>
