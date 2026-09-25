import { building } from '$app/environment';
import { redirect, type Handle } from '@sveltejs/kit';
import {
	authenticateRequest,
	matchesConfiguredToken,
	serviceUser,
	sessionCookieName
} from '$lib/server/auth';
import { startHaLidarrWatch } from '$lib/server/ha-lidarr-watch';

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

	try {
		startHaLidarrWatch();
	} catch (e) {
		console.warn('[startup] HA→Lidarr watch failed:', e);
	}
}

const publicPages = new Set(['/login', '/register']);
const publicPaths = new Set([
	'/favicon',
	'/robots.txt',
	'/service-worker.js',
	'/manifest.webmanifest',
	'/api/health'
]);

function normalizedPathname(pathname: string): string {
	return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

function isPublicPath(pathname: string): boolean {
	const normalized = normalizedPathname(pathname);
	return publicPages.has(normalized) || publicPaths.has(normalized) || pathname.startsWith('/_app/');
}

function isInternalJob(pathname: string): boolean {
	const normalized = normalizedPathname(pathname);
	return normalized === '/api/analyze' || normalized === '/api/sync-favorites';
}

function isExternalPlaybackRequest(event: Parameters<Handle>[0]['event']): boolean {
	return normalizedPathname(event.url.pathname) === '/api/play-vibe' && event.request.method === 'POST';
}

export const handle: Handle = async ({ event, resolve }) => {
	// Worker endpoints have their own WORKER_TOKEN auth and must not be
	// intercepted by the browser-session guard.
	if (building || event.url.pathname === '/api/worker' || event.url.pathname.startsWith('/api/worker/')) {
		event.locals.user = null;
		event.locals.session = null;
		event.locals.method = null;
		return resolve(event);
	}

	// These two service routes are called by the internal Compose jobs. They
	// use WORKER_TOKEN, but it is accepted only for these exact endpoints.
	if (
		event.request.method === 'POST' &&
		isInternalJob(event.url.pathname) &&
		matchesConfiguredToken(event.request, 'WORKER_TOKEN')
	) {
		event.locals.user = serviceUser;
		event.locals.session = null;
		event.locals.method = 'service';
		return resolve(event);
	}

	// Home Assistant may trigger the external playback action with its own
	// dedicated key. It is deliberately limited to the playback POST route.
	if (
		isExternalPlaybackRequest(event) &&
		matchesConfiguredToken(event.request, 'PLAYBACK_API_KEY')
	) {
		event.locals.user = serviceUser;
		event.locals.session = null;
		event.locals.method = 'service';
		return resolve(event);
	}

	const auth = await authenticateRequest(event);
	event.locals.user = auth.user;
	event.locals.session = auth.session;
	event.locals.method = auth.method;

	if (auth.user || isPublicPath(event.url.pathname)) return resolve(event);

	if (event.url.pathname.startsWith('/api/')) {
		return Response.json(
			{ error: 'authentication required' },
			{ status: 401, headers: { 'WWW-Authenticate': 'Bearer' } }
		);
	}

	const returnTo = `${event.url.pathname}${event.url.search}`;
	redirect(302, `/login?redirect=${encodeURIComponent(returnTo)}`);
};

export { sessionCookieName };
