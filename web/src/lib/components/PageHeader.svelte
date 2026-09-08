<script lang="ts">
	let {
		title,
		description,
		kicker
	}: { title: string; description?: string; kicker?: string } = $props();
</script>

<header class="mb-8 animate-rise">
	{#if kicker}
		<p class="mb-2 flex items-center gap-2 text-[11px] font-bold tracking-[0.28em] text-accent-deep uppercase">
			<span class="inline-block h-px w-8 bg-accent"></span>
			{kicker}
		</p>
	{/if}
	<h1 class="max-w-3xl font-display text-4xl leading-[1.02] font-black tracking-tight text-balance sm:text-5xl">
		{title}
	</h1>
	{#if description}
		<p class="mt-3 max-w-2xl text-base leading-relaxed text-ink-soft">{description}</p>
	{/if}
</header>
