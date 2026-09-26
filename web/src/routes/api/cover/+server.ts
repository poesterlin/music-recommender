import type { RequestHandler } from './$types';

const SIZES = new Set(['80', '160', '256', '512', '1024']);
const DEFAULT_SIZE = '256';

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) {
		return Response.json({ error: 'authentication required' }, { status: 401 });
	}

	const path = url.searchParams.get('path') ?? '';
	// Only the imageproxy path is accepted, never a full URL, so this cannot be
	// used as an open proxy to arbitrary hosts.
	if (!/^\/imageproxy\/[A-Za-z0-9_-]+$/.test(path)) {
		return Response.json({ error: 'invalid cover path' }, { status: 400 });
	}
	const requested = url.searchParams.get('size') ?? DEFAULT_SIZE;
	const size = SIZES.has(requested) ? requested : DEFAULT_SIZE;

	const host = (process.env.MUSIC_HOST ?? '').replace(/\/$/, '');
	if (!host) {
		return Response.json({ error: 'cover art is not configured' }, { status: 503 });
	}

	try {
		const upstream = await fetch(`${host}${path}?size=${size}`);
		if (!upstream.ok || !upstream.body) {
			return Response.json({ error: 'cover art unavailable' }, { status: 502 });
		}
		return new Response(upstream.body, {
			status: 200,
			headers: {
				'Content-Type': upstream.headers.get('content-type') ?? 'image/jpeg',
				// Covers are content-addressed by the imageproxy hash, so they
				// cache well and never change for a given path.
				'Cache-Control': 'private, max-age=86400'
			}
		});
	} catch (error) {
		console.error('Cover proxy failed:', error);
		return Response.json({ error: 'cover art unavailable' }, { status: 502 });
	}
};
