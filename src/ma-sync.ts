/**
 * Trigger a Music Assistant library sync over its native WebSocket API
 * and wait for the sync tasks to finish.
 *
 * Same sync as the "Sync" button in the MA frontend (music/sync),
 * scoped to the enabled music providers (e.g. Plex).
 *
 * Required env: MUSIC_HOST (https base URL), MA_TOKEN (MA access token).
 */

type WSMessage = { message_id?: string | number; result?: any; error_code?: number; details?: string };

const ACTIVE = new Set(["pending", "running", "idle"]);

function wsUrl(): string {
  const base = (process.env.MUSIC_HOST ?? "").replace(/\/$/, "");
  if (!base) throw new Error("MUSIC_HOST is not set");
  return base.replace(/^http/, "ws") + "/ws";
}

function call(ws: WebSocket, id: number, command: string, args?: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      let m: WSMessage;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (String(m.message_id ?? "") !== String(id)) return;
      ws.removeEventListener("message", onMessage);
      if (m.error_code) reject(new Error(`${command} failed: ${m.details ?? m.error_code}`));
      else resolve(m.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ message_id: id, command, args }));
  });
}

function connect(url: string, timeoutMs = 15000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("MA websocket connect timeout")), timeoutMs);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("MA websocket connection failed"));
    };
  });
}

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

  const ws = await connect(wsUrl());
  try {
    const auth = await call(ws, 1, "auth", { token });
    if (!auth?.authenticated) throw new Error("MA authentication failed");

    const providers: any[] = await call(ws, 2, "config/providers");
    const enabledMusic = providers.filter((p) => p?.type === "music" && p?.enabled !== false);
    const only = (process.env.MA_SYNC_PROVIDERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const musicProviders = enabledMusic
      .map((p) => String(p.instance_id))
      .filter((id) => !only.length || only.includes(id));
    if (!musicProviders.length) throw new Error("No matching MA music providers found");

    const started: any[] = await call(ws, 3, "music/sync", { providers: musicProviders });
    const taskIds = new Set((started ?? []).map((t: any) => String(t.id)));
    console.log(`[ma-sync] syncing ${musicProviders.join(", ")} (${taskIds.size} tasks)`);

    const deadline = Date.now() + timeoutMs;
    let tasks: any[] = started ?? [];
    for (;;) {
      const all: any[] = await call(ws, 4, "tasks/list");
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
  } finally {
    ws.close();
  }
}
