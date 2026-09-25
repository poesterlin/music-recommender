<script lang="ts">
	let { title, description, kicker }: { title: string; description?: string; kicker?: string } =
		$props();
</script>

<header class="animate-rise mb-8">
	{#if kicker}
		<p
			class="text-accent-deep mb-2 flex items-center gap-2 text-[11px] font-bold tracking-[0.28em] uppercase"
		>
			<span class="bg-accent inline-block h-px w-8"></span>
			{kicker}
		</p>
	{/if}
	<h1
		class="font-display max-w-3xl text-4xl leading-[1.02] font-black tracking-tight text-balance sm:text-5xl"
	>
		{title}
	</h1>
	{#if description}
		<p class="text-ink-soft mt-3 max-w-2xl text-base leading-relaxed">{description}</p>
	{/if}
</header>
