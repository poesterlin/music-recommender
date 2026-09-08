<script lang="ts">
	import {
		IconActivity,
		IconCalendarTime,
		IconCompass,
		IconDisc,
		IconHome,
		IconSparkles,
		IconTool,
		IconWand
	} from '@tabler/icons-svelte';
	import { page } from '$app/state';
	import { toastStore } from '$lib/client/toast.svelte';
	import { slide } from 'svelte/transition';
	import { onNavigate } from '$app/navigation';
	import { post } from '$lib/api';
	import { CLUSTER_NAMES } from '$lib/clusters';
	import '../app.css';

	let { children, data } = $props();

	const links = [
		{ href: '/', label: 'Home', icon: IconHome },
		{ href: '/vibe', label: 'Vibe Mixer', icon: IconSparkles },
		{ href: '/schedule', label: 'Schedule', icon: IconCalendarTime },
		{ href: '/explore', label: 'Explore', icon: IconCompass },
		{ href: '/recommend', label: 'Recommend', icon: IconWand },
		{ href: '/activity', label: 'Activity', icon: IconActivity },
		{ href: '/manage', label: 'Manage', icon: IconTool }
	];

	onNavigate((navigation) => {
		if (!document.startViewTransition) return;
		return new Promise((resolve) => {
			document.startViewTransition(async () => {
				resolve();
				await navigation.complete;
			});
		});
	});

	async function like() {
		const { ok } = await post('/track/like', { source: 'web' });
		if (ok) toastStore.show('Liked — spun into future mixes');
	}

	async function skip() {
		const { ok } = await post('/track/skip');
		if (ok) toastStore.show('Skipped');
	}
</script>

<div class="grain min-h-screen bg-paper font-body text-ink">
	<header class="sticky top-0 z-40 border-b border-ink/15 bg-paper/90 backdrop-blur">
		<div class="mx-auto max-w-6xl px-6 pt-4 pb-3">
			<div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
				<a href="/" class="group flex items-baseline gap-3">
					<IconDisc
						class="size-6 translate-y-1 text-accent transition-transform duration-700 group-hover:rotate-180"
						size={24}
					/>
					<span class="font-display text-2xl font-black tracking-tight">
						Music Recommender
					</span>
					<span class="hidden text-[11px] font-bold tracking-[0.25em] text-faded uppercase sm:inline">
						The listening bar
					</span>
				</a>
				{#if data.nowPlaying}
					<div class="flex max-w-full items-center gap-3 text-sm">
						<span class="relative flex size-2 shrink-0">
							<span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60"></span>
							<span class="relative inline-flex size-2 rounded-full bg-accent"></span>
						</span>
						<div class="min-w-0 text-right">
							<p class="max-w-56 truncate font-bold">{data.nowPlaying.name}</p>
							<p class="max-w-56 truncate text-xs text-ink-soft">
								{data.nowPlaying.artists.join(', ')}
								{#if data.nowPlaying.clusterId !== undefined && data.nowPlaying.clusterId !== null}
									· {CLUSTER_NAMES[data.nowPlaying.clusterId] ??
										'Cluster ' + data.nowPlaying.clusterId}
								{/if}
							</p>
						</div>
						<button
							class="rounded-full bg-moss/15 px-3 py-1 text-xs font-bold text-moss transition hover:bg-moss hover:text-cream"
							onclick={like}>Like</button
						>
						<button
							class="rounded-full bg-accent/10 px-3 py-1 text-xs font-bold text-accent-deep transition hover:bg-accent hover:text-cream"
							onclick={skip}>Skip</button
						>
					</div>
				{/if}
			</div>
			<nav class="mt-3 flex flex-wrap items-center gap-1 border-t border-ink/10 pt-2.5">
				{#each links as l (l.href)}
					{@const Icon = l.icon}
					{@const active = page.url.pathname === l.href}
					<a
						href={l.href}
						class="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-bold tracking-wide transition-all {active
							? 'bg-ink text-cream'
							: 'text-ink-soft hover:bg-ink/5 hover:text-ink'}"
					>
						<Icon size={15} />
						{l.label}
					</a>
				{/each}
			</nav>
		</div>
	</header>

	<main class="mx-auto max-w-6xl px-6 py-10">
		{@render children()}
	</main>

	<footer class="mx-auto max-w-6xl px-6 pb-10">
		<div class="flex flex-wrap items-center justify-between gap-2 border-t border-ink/10 pt-4 text-xs text-faded">
			<p class="font-display italic">Spun locally, saved lovingly.</p>
			<p class="font-bold tracking-[0.2em] uppercase">Side A · always on</p>
		</div>
	</footer>

	{#each toastStore.toasts as toast, i (toast.id)}
		<div
			class="fixed right-4 bottom-4 z-50"
			in:slide={{ duration: 300 }}
			out:slide={{ duration: 300 }}
			style="translate: 0 {i * -4}rem;"
		>
			<div
				class="rounded-2xl border-l-4 border-accent bg-ink p-4 text-cream shadow-xl"
				style="min-width: 300px"
			>
				<p class="text-sm font-semibold">{toast.message}</p>
			</div>
		</div>
	{/each}
</div>
