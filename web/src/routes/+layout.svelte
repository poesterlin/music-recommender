<script lang="ts">
	import {
		IconDisc,
		IconHeartbeat,
		IconHome,
		IconLogout,
		IconSparkles,
		IconTool,
		IconWand
	} from '@tabler/icons-svelte';
	import { page } from '$app/state';
	import { toastStore } from '$lib/client/toast.svelte';
	import { likeTrack } from '$lib/client/like-track';
	import { nowPlayingStore } from '$lib/client/now-playing.svelte';
	import { slide } from 'svelte/transition';
	import { onMount, onDestroy } from 'svelte';
	import { onNavigate } from '$app/navigation';
	import { post } from '$lib/api';
	import '../app.css';

	let { children, data } = $props();

	// Header shows the LIVE track (same store the booth Player updates),
	// never a stale server snapshot — so Like/Skip hit the displayed song.
	// SSR first paint falls back to the server snapshot until the store hydrates.
	$effect(() => {
		nowPlayingStore.seed(data.nowPlaying);
	});

	const shown = $derived(nowPlayingStore.track ?? data.nowPlaying);

	let poller: ReturnType<typeof setInterval> | null = null;
	onMount(() => {
		// Backstop for pages without the booth Player (which polls faster).
		void nowPlayingStore.refresh();
		poller = setInterval(() => nowPlayingStore.refresh(), 15000);
	});
	onDestroy(() => {
		if (poller) clearInterval(poller);
	});

	// Primary navigation only. Explore and Schedule are Vibe tabs, API keys
	// live under Manage, and worker status is a badge rather than a full item.
	const links = [
		{ href: '/', label: 'Home', icon: IconHome },
		{ href: '/vibe', label: 'Vibe', icon: IconSparkles },
		{ href: '/recommend', label: 'Recommend', icon: IconWand }
	];

	// /vibe owns three tabs, so treat its variants as one active item.
	function isActive(href: string): boolean {
		const path = page.url.pathname;
		return href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`);
	}

	const workerAge = $derived.by(() => {
		if (!data.workerLastSeenAt) return 'no data';
		const minutes = Math.max(
			0,
			Math.round((Date.now() - new Date(data.workerLastSeenAt).getTime()) / 60000)
		);
		if (minutes < 1) return 'just now';
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.round(minutes / 60);
		if (hours < 48) return `${hours}h ago`;
		return `${Math.round(hours / 24)}d ago`;
	});

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
		const track = nowPlayingStore.track ?? data.nowPlaying;
		if (!track) {
			toastStore.show('Nothing playing to like');
			return;
		}
		await likeTrack(track.uri, track.name);
	}

	async function skip() {
		const uri = nowPlayingStore.track?.uri ?? data.nowPlaying?.uri;
		if (!uri) {
			toastStore.show('Nothing playing to skip');
			return;
		}
		const { ok } = await post('/track/skip', { uri });
		if (ok) toastStore.show('Skipped');
	}
</script>

<div class="grain bg-paper font-body text-ink min-h-screen">
	<header class="border-ink/15 bg-paper/90 sticky top-0 z-40 border-b backdrop-blur">
		<div class="mx-auto max-w-6xl px-6 pt-4 pb-3">
			<div class="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
				<a href="/" class="group flex items-baseline gap-3">
					<IconDisc
						class="text-accent size-6 translate-y-1 transition-transform duration-700 group-hover:rotate-180"
						size={24}
					/>
					<span class="font-display text-2xl font-black tracking-tight"> Music Recommender </span>
				</a>
				{#if shown}
					<div class="flex max-w-full items-center gap-3 text-sm">
						<span class="relative flex size-2 shrink-0">
							<span
								class="bg-accent absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
							></span>
							<span class="bg-accent relative inline-flex size-2 rounded-full"></span>
						</span>
						<div class="min-w-0 text-right">
							<p class="max-w-56 truncate font-bold">{shown.name}</p>
							<p class="text-ink-soft max-w-56 truncate text-xs">
								{shown.artists.join(', ')}
							</p>
						</div>
						<button
							class="bg-moss/15 text-moss hover:bg-moss hover:text-cream rounded-full px-3 py-1 text-xs font-bold transition"
							onclick={like}>Like</button
						>
						<button
							class="bg-accent/10 text-accent-deep hover:bg-accent hover:text-cream rounded-full px-3 py-1 text-xs font-bold transition"
							onclick={skip}>Skip</button
						>
					</div>
				{/if}
			</div>
			<div
				class="border-ink/10 mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t pt-2.5"
			>
				<nav class="flex flex-wrap items-center gap-1">
					{#each links as l (l.href)}
						{@const Icon = l.icon}
						<a
							href={l.href}
							aria-current={isActive(l.href) ? 'page' : undefined}
							class="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-bold tracking-wide transition-all {isActive(
								l.href
							)
								? 'bg-ink text-cream'
								: 'text-ink-soft hover:bg-ink/5 hover:text-ink'}"
						>
							<Icon size={15} />
							{l.label}
						</a>
					{/each}
				</nav>
				<div class="flex flex-wrap items-center gap-2 text-xs font-bold">
					<a
						href="/status"
						title="Worker status and embedding coverage"
						class="border-ink/15 text-ink-soft hover:bg-ink/5 hover:text-ink flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 transition"
					>
						<IconHeartbeat size={14} />
						Worker
						<span class="font-mono text-[11px]">{workerAge}</span>
					</a>
					<a
						href="/manage"
						aria-current={isActive('/manage') ? 'page' : undefined}
						class="flex items-center gap-1.5 rounded-full px-2.5 py-1.5 transition {isActive(
							'/manage'
						)
							? 'bg-ink text-cream'
							: 'text-ink-soft hover:bg-ink/5 hover:text-ink'}"
					>
						<IconTool size={14} />
						Manage
					</a>
					{#if data.user}
						<form method="POST" action="/logout" class="flex items-center">
							<button
								class="text-ink-soft hover:bg-ink/5 hover:text-ink inline-flex cursor-pointer items-center gap-1 rounded-full px-2 py-1.5"
								type="submit"
							>
								<IconLogout size={14} /> Log out
							</button>
						</form>
					{:else}
						<a class="text-accent-deep hover:bg-accent/10 rounded-full px-2 py-1.5" href="/login"
							>Log in</a
						>
					{/if}
				</div>
			</div>
		</div>
	</header>

	<main class="mx-auto max-w-6xl px-6 py-10">
		{@render children()}
	</main>

	<footer class="mx-auto max-w-6xl px-6 pb-10">
		<div
			class="border-ink/10 text-faded flex flex-wrap items-center justify-between gap-2 border-t pt-4 text-xs"
		>
			<p class="font-display italic">OpenL3 embeddings, clustered locally.</p>
			<p class="font-bold tracking-[0.2em] uppercase">MIT licensed</p>
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
				class="border-accent bg-ink text-cream rounded-2xl border-l-4 p-4 shadow-xl"
				style="min-width: 300px"
			>
				<p class="text-sm font-semibold">{toast.message}</p>
			</div>
		</div>
	{/each}
</div>
