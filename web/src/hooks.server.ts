import { building } from '$app/environment';
import type { Handle } from '@sveltejs/kit';

// App-level startup: seed persisted vibe state and start the WLED
// visualizer loop. Skipped during prerender/build.
if (!building) {
	void import('$lib/server/vibe-store').then(({ ensureVibeSeeded }) =>
		ensureVibeSeeded().catch((e) => console.warn('[startup] vibe seed failed:', e))
	);

	if (process.env.WLED_IP) {
		console.log(`Using WLED IP: ${process.env.WLED_IP}`);
		void import('$lib/server/wled-visualizer').then(({ startWLEDVisualization }) =>
			startWLEDVisualization(process.env.WLED_IP as string).catch((e) =>
				console.warn('[startup] WLED visualization failed:', e)
			)
		);
	} else {
		console.warn('WLED_IP environment variable is not set; WLED visualization disabled.');
	}
}

export const handle: Handle = async ({ event, resolve }) => resolve(event);
