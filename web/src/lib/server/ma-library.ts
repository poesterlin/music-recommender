/**
 * Music Assistant library access over the native WebSocket API.
 *
 * Music Assistant registers `music/<media_type>s/library_items` for every media
 * type, with the same paging primitives Home Assistant's `get_library` service
 * exposed (`limit`, `offset`, `order_by`, `favorite`, `search`). Using it
 * directly means the library no longer depends on Home Assistant at all, and
 * drops roughly an order of magnitude of round trips: a 30k-track library is
 * ~15 requests at 2000 per page instead of ~105.
 *
 * One connection is held open across every page of a scan. Reconnecting per
 * page would re-handshake on each of those requests and the handshake, not the
 * payload, would dominate.
 */

import { withMa } from './ma-client';

/** Subset of Music Assistant's image descriptor. `proxy_id` is the content hash. */
export interface MaImage {
	proxy_id?: string | null;
	path?: string | null;
	type?: string | null;
	provider?: string | null;
}

export interface MaArtist {
	name?: string | null;
	uri?: string | null;
}

export interface MaAlbum {
	name?: string | null;
	uri?: string | null;
	image?: MaImage | string | null;
	year?: number | null;
}

export interface MaTrack {
	uri?: string | null;
	name?: string | null;
	version?: string | null;
	artists?: MaArtist[] | null;
	album?: MaAlbum | null;
	favorite?: boolean | null;
	duration?: number | null;
}

export type LibraryScanOptions = {
	/** Restrict to favourites. Omit for the whole library. */
	favorite?: boolean;
	/** Items per request. 2000 measured fastest per item; larger pages still work. */
	limit?: number;
	orderBy?: string;
};

const DEFAULT_PAGE_SIZE = 2000;

/**
 * The cover proxy accepts exactly `/imageproxy/<token>` and rejects anything
 * else with a 400, so the token is validated here rather than letting a
 * malformed value turn into a broken image request later.
 */
const IMAGE_PROXY_TOKEN = /^[A-Za-z0-9_-]+$/;

/**
 * Reduce a Music Assistant album image to the bare imageproxy path.
 *
 * Music Assistant returns an image *descriptor*, not a URL:
 * `{type, path, provider, remotely_accessible, proxy_id}`. The `proxy_id` is
 * the content hash the app already stores, and Music Assistant's canonical URL
 * is `{MUSIC_HOST}/imageproxy/{proxy_id}` — so the path alone is all that is
 * needed, and the host is re-applied at render time by `/api/cover`. Storing a
 * full URL would bake a deployment-specific address into the database.
 *
 * A bare string is still accepted so a provider that hands back a full URL is
 * normalised the same way rather than silently dropping its cover.
 */
export function imageProxyPath(image: MaImage | string | null | undefined): string | null {
	if (!image) return null;

	if (typeof image === 'string') {
		try {
			const url = new URL(image);
			if (!url.pathname.startsWith('/imageproxy/')) return null;
			if (!IMAGE_PROXY_TOKEN.test(url.pathname.slice('/imageproxy/'.length))) return null;
			return url.pathname;
		} catch {
			return null;
		}
	}

	const token = image.proxy_id?.trim();
	if (!token || !IMAGE_PROXY_TOKEN.test(token)) return null;
	return `/imageproxy/${token}`;
}

/**
 * Walk the whole library one page at a time, on a single connection.
 *
 * `onPage` is awaited, so a caller can write each page to the database as it
 * arrives instead of buffering the library; memory stays flat regardless of
 * size. Returns the number of rows reported.
 */
export async function scanLibrary(
	options: LibraryScanOptions,
	onPage: (tracks: MaTrack[], offset: number) => Promise<void>
): Promise<number> {
	const limit = options.limit ?? DEFAULT_PAGE_SIZE;
	const args: Record<string, unknown> = {
		limit,
		offset: 0,
		order_by: options.orderBy ?? 'sort_name'
	};
	if (options.favorite !== undefined) args.favorite = options.favorite;

	return withMa(async (call) => {
		let fetched = 0;
		for (;;) {
			const page: unknown = await call('music/tracks/library_items', args);
			if (!Array.isArray(page) || page.length === 0) break;

			await onPage(page as MaTrack[], Number(args.offset));
			fetched += page.length;

			if (page.length < limit) break;
			args.offset = Number(args.offset) + limit;
		}
		return fetched;
	});
}
