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

# OpenL3 predict batch. 64 is safe on CPU; 128-256 helps on a GPU.
# This is not the same as --batch-size, which is the page size (max 32).
infer_batch_size = os.environ.get("EMBEDDING_INFER_BATCH_SIZE", "64")

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
        "--infer-batch-size",
        infer_batch_size,
        "--dry-run",      # remove these two for the real run
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
if returncode == 0:
    print("Done; nothing pending.")
elif returncode == 2:
    print("Pending tracks remain (expected). Check run_summary for failures.")
elif returncode == 64:
    raise RuntimeError("Worker configuration rejected (exit 64); nothing was processed.")
else:
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
		return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(
			new Date(value)
		);
	}

	function keyStatus(key: { active: boolean; revokedAt: string | null }): string {
		if (key.revokedAt) return 'Revoked';
		return key.active ? 'Active' : 'Expired';
	}
</script>

<svelte:head><title>Access · Music Recommender</title></svelte:head>

<PageHeader
	kicker="Manage"
	title="Access"
	description="Scoped keys for the embedding worker and Home Assistant. Each key is shown once and can be revoked here."
/>

<div class="grid gap-6 lg:grid-cols-2">
	<section class="border-ink/10 rounded-2xl border bg-white/80 p-6 shadow-sm">
		<div class="flex items-start gap-3">
			<div class="bg-accent/10 text-accent-deep rounded-xl p-2"><IconKey size={22} /></div>
			<div>
				<h2 class="text-lg font-bold">Create a key</h2>
				<p class="text-ink-soft mt-1 text-sm">Use a separate key for each external integration.</p>
			</div>
		</div>

		<form method="POST" action="?/create" use:enhance class="mt-6 space-y-4">
			<div>
				<label class="mb-1 block text-sm font-bold" for="key-name">Name</label>
				<input
					class="border-ink/20 bg-paper focus:border-accent w-full rounded-lg border px-3 py-2 outline-none"
					id="key-name"
					name="name"
					placeholder="Colab worker"
					required
				/>
			</div>
			<div>
				<label class="mb-1 block text-sm font-bold" for="key-scope">Purpose</label>
				<select
					class="border-ink/20 bg-paper focus:border-accent w-full rounded-lg border px-3 py-2 outline-none"
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
					class="border-ink/20 bg-paper focus:border-accent w-full rounded-lg border px-3 py-2 outline-none"
					id="key-expiry"
					name="expiresInDays"
				>
					<option value="never">Never</option>
					<option value="30">30 days</option>
					<option value="90">90 days</option>
					<option value="365">1 year</option>
				</select>
			</div>
			<button
				class="bg-ink text-cream hover:bg-ink-soft cursor-pointer rounded-lg px-4 py-2 font-bold transition"
				type="submit"
			>
				Create API key
			</button>
		</form>

		{#if form?.message}
			<p class="bg-ink/5 text-ink-soft mt-4 rounded-lg px-3 py-2 text-sm">{form.message}</p>
		{/if}

		{#if form?.createdKey}
			<div class="border-accent/30 bg-accent/5 mt-4 rounded-xl border p-4">
				<p class="text-ink text-sm font-bold">Copy this key now. It will not be shown again.</p>
				<div class="mt-3 flex items-start gap-2">
					<code
						class="bg-ink text-cream min-w-0 flex-1 overflow-x-auto rounded-lg px-3 py-2 text-xs break-all"
						>{form.createdKey.secret}</code
					>
					<button
						class="bg-accent hover:bg-accent-deep inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-lg px-3 py-2 text-xs font-bold text-white"
						type="button"
						onclick={() => copyText(form.createdKey.secret, 'secret')}
					>
						<IconClipboardCopy size={15} />
						{copied === 'secret' ? 'Copied' : 'Copy'}
					</button>
				</div>
				<p class="text-ink-soft mt-2 text-xs">
					Scope: {form.createdKey.scope === 'worker'
						? 'Embedding worker API'
						: 'Home Assistant playback POST'}.
				</p>
			</div>
		{/if}
	</section>

	<section class="border-ink/10 rounded-2xl border bg-white/80 p-6 shadow-sm">
		<div class="flex items-start gap-3">
			<div class="bg-moss/10 text-moss rounded-xl p-2"><IconKey size={22} /></div>
			<div>
				<h2 class="text-lg font-bold">Your keys</h2>
				<p class="text-ink-soft mt-1 text-sm">
					Revoke a key immediately if an integration is no longer trusted.
				</p>
			</div>
		</div>

		{#if data.keys.length === 0}
			<p
				class="border-ink/20 text-faded mt-6 rounded-xl border border-dashed px-4 py-6 text-center text-sm"
			>
				No API keys yet.
			</p>
		{:else}
			<ul class="divide-ink/10 mt-5 divide-y">
				{#each data.keys as key (key.id)}
					<li class="py-4 first:pt-0 last:pb-0">
						<div class="flex flex-wrap items-start justify-between gap-3">
							<div class="min-w-0">
								<p class="font-bold">{key.name}</p>
								<p class="text-ink-soft mt-1 text-xs">
									{key.scope === 'worker' ? 'Embedding worker API' : 'Home Assistant playback'} ·
									<code>{key.keyPrefix}…</code>
								</p>
							</div>
							<span
								class="rounded-full px-2.5 py-1 text-xs font-bold {keyStatus(key) === 'Active'
									? 'bg-moss/15 text-moss'
									: 'bg-ink/10 text-faded'}"
							>
								{keyStatus(key)}
							</span>
						</div>
						<div class="text-faded mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
							<span>Created {formatDate(key.createdAt)}</span>
							<span>Last used {formatDate(key.lastUsedAt)}</span>
							{#if key.expiresAt}<span>Expires {formatDate(key.expiresAt)}</span>{/if}
						</div>
						{#if !key.revokedAt}
							<form method="POST" action="?/revoke" use:enhance class="mt-3">
								<input type="hidden" name="id" value={key.id} />
								<button
									class="cursor-pointer text-xs font-bold text-red-700 hover:text-red-900"
									type="submit">Revoke key</button
								>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>

<section class="border-ink/10 mt-6 rounded-2xl border bg-white/80 p-6 shadow-sm">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h2 class="text-lg font-bold">Worker notebook cell</h2>
			<p class="text-ink-soft mt-1 max-w-2xl text-sm">
				Copy this into a Colab or Jupyter cell after creating a Worker key. It runs a one-track dry
				run first; check <code>run_summary</code> for failures, then remove
				<code>--dry-run</code> and <code>--limit 1</code> to write embeddings. Progress appears under
				Worker once the first batch uploads.
			</p>
		</div>
		<div class="flex gap-2">
			<button
				class="bg-ink text-cream hover:bg-ink-soft inline-flex cursor-pointer items-center gap-1 rounded-lg px-3 py-2 text-xs font-bold"
				type="button"
				onclick={() => copyText(workerCell, 'notebook')}
			>
				<IconClipboardCopy size={15} />
				{copied === 'notebook' ? 'Copied' : 'Copy cell'}
			</button>
			<a
				class="border-ink/15 hover:bg-ink/5 rounded-lg border px-3 py-2 text-xs font-bold"
				href="/music-recommender-worker.ipynb"
				download>Download notebook</a
			>
		</div>
	</div>
	<pre class="bg-ink text-cream mt-5 overflow-x-auto rounded-xl p-4 text-xs leading-relaxed"><code
			>{workerCell}</code
		></pre>
</section>
