/**
 * Shared Music Assistant native WebSocket API client.
 * Connects to the MA server behind MUSIC_HOST (same origin serves /ws),
 * authenticates with MA_TOKEN.
 */

export type MaMessage = {
  message_id?: string | number;
  result?: any;
  error_code?: number;
  details?: string;
};

export function maWsUrl(): string {
  const base = (process.env.MUSIC_HOST ?? "").replace(/\/$/, "");
  if (!base) throw new Error("MUSIC_HOST is not set");
  return base.replace(/^http/, "ws") + "/ws";
}

export function maCall(ws: WebSocket, id: number, command: string, args?: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent) => {
      let m: MaMessage;
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

export function maConnect(timeoutMs = 15000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(maWsUrl());
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

/** Open an authenticated MA connection, run fn, always close. */
export async function withMa<T>(
  fn: (call: (command: string, args?: Record<string, unknown>) => Promise<any>) => Promise<T>,
): Promise<T> {
  const token = process.env.MA_TOKEN;
  if (!token) throw new Error("MA_TOKEN is not set");
  const ws = await maConnect();
  try {
    const auth = await maCall(ws, 1, "auth", { token });
    if (!auth?.authenticated) throw new Error("MA authentication failed");
    let nextId = 2;
    return await fn((command, args) => maCall(ws, nextId++, command, args));
  } finally {
    ws.close();
  }
}
