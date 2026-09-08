import { toastStore } from '$lib/client/toast.svelte';

export async function api<T = unknown>(
	path: string,
	init?: RequestInit
): Promise<{ ok: boolean; data: T }> {
	let res: Response;
	try {
		res = await fetch(path, init);
	} catch {
		toastStore.show('Could not reach the server');
		return { ok: false, data: {} as T };
	}
	const data = (await res.json().catch(() => ({}))) as T;
	if (!res.ok) {
		toastStore.show((data as { error?: string })?.error ?? `Request failed (${res.status})`);
	}
	return { ok: res.ok, data };
}

export function post<T = unknown>(path: string, body?: unknown) {
	return api<T>(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
}
