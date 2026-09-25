<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/state';

	let { form } = $props();
</script>

<svelte:head><title>Register · Music Recommender</title></svelte:head>

<div class="mx-auto flex min-h-[70vh] max-w-md items-center justify-center px-6">
	<div class="w-full rounded-2xl border border-ink/10 bg-white/80 p-8 shadow-xl">
		<p class="text-xs font-bold tracking-[0.2em] text-accent uppercase">Music Recommender</p>
		<h1 class="mt-2 font-display text-3xl font-black">Create an account</h1>
		<form method="POST" action="?/register" use:enhance class="mt-6 space-y-4">
			<div>
				<label class="mb-1 block text-sm font-bold" for="username">Username</label>
				<input class="w-full rounded-lg border border-ink/20 bg-paper px-3 py-2 outline-none focus:border-accent" id="username" name="username" autocomplete="username" required />
			</div>
			<div>
				<label class="mb-1 block text-sm font-bold" for="email">Email <span class="font-normal text-ink-soft">(optional)</span></label>
				<input class="w-full rounded-lg border border-ink/20 bg-paper px-3 py-2 outline-none focus:border-accent" id="email" name="email" type="email" autocomplete="email" />
			</div>
			<div>
				<label class="mb-1 block text-sm font-bold" for="password">Password</label>
				<input class="w-full rounded-lg border border-ink/20 bg-paper px-3 py-2 outline-none focus:border-accent" id="password" name="password" type="password" autocomplete="new-password" minlength="8" required />
			</div>
			{#if form?.message}
				<p class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{form.message}</p>
			{/if}
			<input type="hidden" name="redirect" value={page.url.searchParams.get('redirect') ?? '/'} />
			<button class="w-full cursor-pointer rounded-lg bg-ink px-4 py-2 font-bold text-cream transition hover:bg-ink-soft" type="submit">Create account</button>
		</form>
		<p class="mt-5 text-center text-sm text-ink-soft">
			Already registered? <a class="font-bold text-accent-deep hover:text-accent" href="/login{page.url.search}">Log in</a>
		</p>
	</div>
</div>
