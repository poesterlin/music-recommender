<script lang="ts">
	import { IconPencil, IconPlayerPlayFilled } from '@tabler/icons-svelte';
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
	class="group border-ink/10 hover:border-ink/25 bg-cream relative flex w-full flex-col overflow-hidden rounded-2xl border text-left transition-all hover:-translate-y-0.5 hover:shadow-lg {selected
		? 'border-accent shadow-md'
		: 'shadow-sm'}"
	onclick={() => onselect(clusterId)}
	aria-pressed={selected}
>
	<div class="bg-line/40 relative aspect-square w-full overflow-hidden">
		{#if primary}
			<img
				src={primary}
				alt=""
				loading="lazy"
				class="size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
			/>
		{:else}
			<div class="text-faded flex size-full items-center justify-center">
				<svg
					viewBox="0 0 24 24"
					class="size-1/3"
					fill="none"
					stroke="currentColor"
					stroke-width="1.25"
				>
					<circle cx="12" cy="12" r="9" />
					<circle cx="12" cy="12" r="2.5" />
				</svg>
			</div>
		{/if}

		{#if secondary}
			<img
				src={secondary}
				alt=""
				loading="lazy"
				class="border-cream absolute right-2 bottom-2 size-1/4 rounded-lg border-2 object-cover shadow-lg transition-transform duration-500 group-hover:translate-x-0.5"
			/>
		{/if}

		{#if named}
			<span
				class="bg-moss text-cream absolute top-2 left-2 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase shadow-sm"
			>
				Named
			</span>
		{/if}
	</div>

	<div class="flex flex-1 flex-col gap-1 p-3">
		<div class="flex items-baseline gap-1.5">
			<span class="text-faded font-mono text-[11px]">#{clusterId}</span>
			{#if !named}
				<IconPencil size={12} class="text-faded opacity-0 transition group-hover:opacity-100" />
			{/if}
		</div>
		<p class="font-display text-sm leading-snug font-black">{name}</p>
		<div class="mt-auto flex items-center justify-between gap-2 pt-1.5">
			{#if trackCount}
				<span class="text-faded text-[11px] tabular-nums">
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
					<IconPlayerPlayFilled size={12} />
					Preview
				</span>
			{/if}
		</div>
	</div>
</button>
