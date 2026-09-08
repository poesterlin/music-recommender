/**
 * Trigger a Music Assistant library sync over its native WebSocket API
 * and wait for the sync tasks to finish.
 *
 * Same sync as the "Sync" button in the MA frontend (music/sync),
 * scoped to the enabled music providers (e.g. Plex).
 *
 * Required env: MUSIC_HOST (https base URL), MA_TOKEN (MA access token).
 */

import { withMa } from "./ma-client";

const ACTIVE = new Set(["pending", "running", "idle"]);

export type MaSyncResult = {
  providers: string[];
  tasks: { id: string; status: string; lastError: string | null }[];
  ok: boolean;
};

/**
 * Sync MA music providers and wait until their sync tasks leave
 * active states. Throws on auth/connection errors; returns ok:false
 * (instead of throwing) when tasks fail or the timeout is hit.
 */
export async function triggerLibrarySync(opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<MaSyncResult> {
  const token = process.env.MA_TOKEN;
  if (!token) throw new Error("MA_TOKEN is not set");
  const timeoutMs = opts.timeoutMs ?? 20 * 60 * 1000;
  const pollMs = opts.pollMs ?? 15_000;

  return withMa(async (call) => {
    const providers: any[] = await call("config/providers");
    const enabledMusic = providers.filter((p) => p?.type === "music" && p?.enabled !== false);
    const only = (process.env.MA_SYNC_PROVIDERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const musicProviders = enabledMusic
      .map((p) => String(p.instance_id))
      .filter((id) => !only.length || only.includes(id));
    if (!musicProviders.length) throw new Error("No matching MA music providers found");

    const started: any[] = await call("music/sync", { providers: musicProviders });
    const taskIds = new Set((started ?? []).map((t: any) => String(t.id)));
    console.log(`[ma-sync] syncing ${musicProviders.join(", ")} (${taskIds.size} tasks)`);

    const deadline = Date.now() + timeoutMs;
    let tasks: any[] = started ?? [];
    for (;;) {
      const all: any[] = await call("tasks/list");
      tasks = all.filter((t) => taskIds.has(String(t.id)));
      const active = tasks.filter((t) => ACTIVE.has(String(t.status)));
      if (!active.length) break;
      if (Date.now() > deadline) {
        console.warn(`[ma-sync] timeout with ${active.length} tasks still active`);
        break;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }

    const summary = tasks.map((t) => ({
      id: String(t.id),
      status: String(t.status),
      lastError: (t.last_error as string | null) ?? null,
    }));
    const ok = summary.length > 0 && summary.every((t) => t.status === "success" || t.status === "partial_success");
    console.log(`[ma-sync] done ok=${ok}: ${summary.map((t) => `${t.id}=${t.status}`).join(", ")}`);
    return { providers: musicProviders, tasks: summary, ok };
  });
}
