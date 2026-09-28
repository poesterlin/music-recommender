<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';
	import type { PageData } from './$types';

	let { data, form }: { data: PageData; form: { message?: string } | undefined } = $props();
</script>

<svelte:head><title>Log in · Sole</title></svelte:head>

<div class="mx-auto flex min-h-[70vh] max-w-md items-center justify-center px-6">
	<div class="border-ink/10 w-full rounded-2xl border bg-white/80 p-8 shadow-xl">
		<img alt="" class="size-10" height="40" src="/logo-mark.png" width="40" />
		<p class="text-accent mt-3 text-xs font-bold tracking-[0.2em] uppercase">Sole</p>
		<h1 class="font-display mt-2 text-3xl font-black">Log in</h1>
		<p class="text-ink-soft mt-2 text-sm">
			Use your account to access the library and playback controls.
		</p>

		<form method="POST" action="?/login" use:enhance class="mt-6 space-y-4">
			<div>
				<label class="mb-1 block text-sm font-bold" for="username">Username</label>
				<input
					class="border-ink/20 bg-paper focus:border-accent w-full rounded-lg border px-3 py-2 outline-none"
					id="username"
					name="username"
					autocomplete="username"
					required
				/>
			</div>
			<div>
				<label class="mb-1 block text-sm font-bold" for="password">Password</label>
				<input
					class="border-ink/20 bg-paper focus:border-accent w-full rounded-lg border px-3 py-2 outline-none"
					id="password"
					name="password"
					type="password"
					autocomplete="current-password"
					required
				/>
			</div>
			{#if form?.message}
				<p class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{form.message}</p>
			{/if}
			<input type="hidden" name="redirect" value={page.url.searchParams.get('redirect') ?? '/'} />
			<button
				class="bg-ink text-cream hover:bg-ink-soft w-full cursor-pointer rounded-lg px-4 py-2 font-bold transition"
				type="submit">Log in</button
			>
		</form>

		{#if data.registrationAvailable}
			<p class="text-ink-soft mt-5 text-center text-sm">
				Need an account? <a
					class="text-accent-deep hover:text-accent font-bold"
					href="/register{page.url.search}">Register</a
				>
			</p>
		{:else}
			<p class="text-ink-soft mt-5 text-center text-sm">
				Need an account? Ask the person who runs Sole.
			</p>
		{/if}
	</div>
</div>
