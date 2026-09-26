/**
 * Client-side cover art URL builder.
 *
 * Mirrors the server helper so components do not need to import server code.
 * Sizes are fixed by Music Assistant's imageproxy; anything else returns 400.
 */
export type CoverSize = 80 | 160 | 256 | 512 | 1024;

export function coverUrl(path: string | null | undefined, size: CoverSize = 256): string | null {
	if (!path || !path.startsWith('/imageproxy/')) return null;
	return `/api/cover?path=${encodeURIComponent(path)}&size=${size}`;
}
