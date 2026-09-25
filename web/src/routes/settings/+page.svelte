<script lang="ts">
	import { enhance } from '$app/forms';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import { IconClipboardCopy, IconKey } from '@tabler/icons-svelte';

	let { data, form } = $props();
	let copied = $state<'secret' | 'notebook' | null>(null);

	const workerCell = $derived(`import getpass
import os
import subprocess
import sys

if sys.version_info < (3, 11):
    raise RuntimeError("The worker requires Python 3.11 or newer.")

repo_url = "https://github.com/poesterlin/music-recommender.git"
repo_dir = "music-recommender"
if not os.path.isdir(os.path.join(repo_dir, "embeddings")):
    subprocess.run(["git", "clone", "--depth", "1", repo_url, repo_dir], check=True)
else:
    subprocess.run(["git", "-C", repo_dir, "pull", "--ff-only"], check=True)
os.chdir(repo_dir)
if sys.version_info >= (3, 12):
    subprocess.run([sys.executable, "embeddings/install_python312.py"], check=True)
else:
    subprocess.run([sys.executable, "-m", "pip", "install", "-r", "embeddings/requirements.txt"], check=True)

os.environ["WORKER_URL"] = ${JSON.stringify(data.workerUrl)}
os.environ["WORKER_TOKEN"] = getpass.getpass("Paste worker API key: ")
env = os.environ.copy()
env["PYTHONUNBUFFERED"] = "1"
process = subprocess.Popen(
    [
        sys.executable,
        "embeddings/worker.py",
        "--source-mode",
        "api",
        "--duration",
        "60",
        "--dry-run",
        "--limit",
        "1",
    ],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    bufsize=1,
    env=env,
)
assert process.stdout is not None
for line in process.stdout:
    print(line, end="", flush=True)
returncode = process.wait()
if returncode == 2:
    print("Dry run completed; pending tracks remain (expected exit code 2).")
elif returncode != 0:
    raise subprocess.CalledProcessError(returncode, process.args)`);

	async function copyText(value: string, kind: 'secret' | 'notebook') {
		try {
			await navigator.clipboard.writeText(value);
			copied = kind;
			setTimeout(() => {
				if (copied === kind) copied = null;
			}, 2500);
		} catch {
			copied = null;
		}
	}

	function formatDate(value: string | null): string {
		if (!value) return 'Never';
		return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(value));
	}

	function keyStatus(key: { active: boolean; revokedAt: string | null }): string {
		if (key.revokedAt) return 'Revoked';
		return key.active ? 'Active' : 'Expired';
	}
</script>

<svelte:head><title>API keys · Music Recommender</title></svelte:head>

<PageHeader
	kicker="Account access"
	title="API keys"
	description="Create narrowly scoped credentials for the embedding worker or Home Assistant. Keys are shown once, can be revoked here, and never grant access to the rest of the app."
/>

<div class="grid gap-6 lg:grid-cols-2">
	<section class="rounded-2xl border border-ink/10 bg-white/80 p-6 shadow-sm">
		<div class="flex items-start gap-3">
			<div class="rounded-xl bg-accent/10 p-2 text-accent-deep"><IconKey size={22} /></div>
			<div>
				<h2 class="text-lg font-bold">Create a key</h2>
				<p class="mt-1 text-sm text-ink-soft">Use a separate key for each external integration.</p>
			</div>
		</div>

		<form method="POST" action="?/create" use:enhance class="mt-6 space-y-4">
			<div>
				<label class="mb-1 block text-sm font-bold" for="key-name">Name</label>
				<input
					class="w-full rounded-lg border border-ink/20 bg-paper px-3 py-2 outline-none focus:border-accent"
					id="key-name"
					name="name"
					placeholder="Colab worker"
					required
				/>
			</div>
			<div>
				<label class="mb-1 block text-sm font-bold" for="key-scope">Purpose</label>
				<select
					class="w-full rounded-lg border border-ink/20 bg-paper px-3 py-2 outline-none focus:border-accent"
					id="key-scope"
					name="scope"
				>
					<option value="worker">Embedding worker API</option>
					<option value="playback">Home Assistant playback POST</option>
				</select>
			</div>
			<div>
				<label class="mb-1 block text-sm font-bold" for="key-expiry">Expires</label>
				<select
					class="w-full rounded-lg border border-ink/20 bg-paper px-3 py-2 outline-none focus:border-accent"
					id="key-expiry"
					name="expiresInDays"
				>
					<option value="never">Never</option>
					<option value="30">30 days</option>
					<option value="90">90 days</option>
					<option value="365">1 year</option>
				</select>
			</div>
			<button class="cursor-pointer rounded-lg bg-ink px-4 py-2 font-bold text-cream transition hover:bg-ink-soft" type="submit">
				Create API key
			</button>
		</form>

		{#if form?.message}
			<p class="mt-4 rounded-lg bg-ink/5 px-3 py-2 text-sm text-ink-soft">{form.message}</p>
		{/if}

		{#if form?.createdKey}
			<div class="mt-4 rounded-xl border border-accent/30 bg-accent/5 p-4">
				<p class="text-sm font-bold text-ink">Copy this key now. It will not be shown again.</p>
				<div class="mt-3 flex items-start gap-2">
					<code class="min-w-0 flex-1 overflow-x-auto rounded-lg bg-ink px-3 py-2 text-xs break-all text-cream">{form.createdKey.secret}</code>
					<button
						class="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-lg bg-accent px-3 py-2 text-xs font-bold text-white hover:bg-accent-deep"
						type="button"
						onclick={() => copyText(form.createdKey.secret, 'secret')}
					>
						<IconClipboardCopy size={15} /> {copied === 'secret' ? 'Copied' : 'Copy'}
					</button>
				</div>
				<p class="mt-2 text-xs text-ink-soft">Scope: {form.createdKey.scope === 'worker' ? 'Embedding worker API' : 'Home Assistant playback POST'}.</p>
			</div>
		{/if}
	</section>

	<section class="rounded-2xl border border-ink/10 bg-white/80 p-6 shadow-sm">
		<div class="flex items-start gap-3">
			<div class="rounded-xl bg-moss/10 p-2 text-moss"><IconKey size={22} /></div>
			<div>
				<h2 class="text-lg font-bold">Your keys</h2>
				<p class="mt-1 text-sm text-ink-soft">Revoke a key immediately if an integration is no longer trusted.</p>
			</div>
		</div>

		{#if data.keys.length === 0}
			<p class="mt-6 rounded-xl border border-dashed border-ink/20 px-4 py-6 text-center text-sm text-faded">No API keys yet.</p>
		{:else}
			<ul class="mt-5 divide-y divide-ink/10">
				{#each data.keys as key (key.id)}
					<li class="py-4 first:pt-0 last:pb-0">
						<div class="flex flex-wrap items-start justify-between gap-3">
							<div class="min-w-0">
								<p class="font-bold">{key.name}</p>
								<p class="mt-1 text-xs text-ink-soft">
									{key.scope === 'worker' ? 'Embedding worker API' : 'Home Assistant playback'} · <code>{key.keyPrefix}…</code>
								</p>
							</div>
							<span class="rounded-full px-2.5 py-1 text-xs font-bold {keyStatus(key) === 'Active' ? 'bg-moss/15 text-moss' : 'bg-ink/10 text-faded'}">
								{keyStatus(key)}
							</span>
						</div>
						<div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-faded">
							<span>Created {formatDate(key.createdAt)}</span>
							<span>Last used {formatDate(key.lastUsedAt)}</span>
							{#if key.expiresAt}<span>Expires {formatDate(key.expiresAt)}</span>{/if}
						</div>
						{#if !key.revokedAt}
							<form method="POST" action="?/revoke" use:enhance class="mt-3">
								<input type="hidden" name="id" value={key.id} />
								<button class="cursor-pointer text-xs font-bold text-red-700 hover:text-red-900" type="submit">Revoke key</button>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>

<section class="mt-6 rounded-2xl border border-ink/10 bg-white/80 p-6 shadow-sm">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h2 class="text-lg font-bold">Colab / Jupyter worker cell</h2>
			<p class="mt-1 max-w-2xl text-sm text-ink-soft">Create a Worker key above, copy this cell into a notebook, and paste the key when prompted. Python 3.11 is recommended. On Python 3.12+, the cell applies a packaging-only compatibility patch for the pinned OpenL3/resampy source releases; model code and versions remain unchanged. Worker JSON events are streamed line-by-line into the cell output. The cell runs a one-track dry run by default; exit code 2 is expected when unembedded tracks remain. Remove `--dry-run` and `--limit 1` only when you are ready to write embeddings.</p>
		</div>
		<div class="flex gap-2">
			<button
				class="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-ink px-3 py-2 text-xs font-bold text-cream hover:bg-ink-soft"
				type="button"
				onclick={() => copyText(workerCell, 'notebook')}
			>
				<IconClipboardCopy size={15} /> {copied === 'notebook' ? 'Copied' : 'Copy cell'}
			</button>
			<a class="rounded-lg border border-ink/15 px-3 py-2 text-xs font-bold hover:bg-ink/5" href="/music-recommender-worker.ipynb" download>Download notebook</a>
		</div>
	</div>
	<pre class="mt-5 overflow-x-auto rounded-xl bg-ink p-4 text-xs leading-relaxed text-cream"><code>{workerCell}</code></pre>
</section>
