const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;
const MAX_ADDRESSES = 10_000;

/** Process-local fixed windows; no persistence or cross-replica coordination. */
export function createLoginThrottle() {
	const attempts = new Map<string, { count: number; expiresAt: number }>();
	let nextCleanup = 0;

	// Zero allows the attempt; a positive value is the retry delay in seconds.
	return (address: string, now = Date.now()): number => {
		if (now >= nextCleanup) {
			for (const [key, entry] of attempts) {
				if (entry.expiresAt <= now) attempts.delete(key);
			}
			nextCleanup = now + WINDOW_MS;
		}

		let entry = attempts.get(address);
		if (entry && entry.expiresAt <= now) {
			attempts.delete(address);
			entry = undefined;
		}
		if (!entry) {
			// Keep memory bounded without evicting an active throttle window.
			if (attempts.size >= MAX_ADDRESSES) return Math.max(1, Math.ceil((nextCleanup - now) / 1_000));
			entry = { count: 0, expiresAt: now + WINDOW_MS };
			attempts.set(address, entry);
		}
		if (entry.count >= MAX_ATTEMPTS) return Math.max(1, Math.ceil((entry.expiresAt - now) / 1_000));
		entry.count++;
		return 0;
	};
}

export const consumeLoginAttempt = createLoginThrottle();
