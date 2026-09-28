import { describe, expect, test } from 'bun:test';
import { imageProxyPath } from './ma-library';

describe('imageProxyPath', () => {
	test('builds a path from Music Assistant image descriptor', () => {
		// Music Assistant returns an image descriptor, not a URL. The proxy_id is
		// already the content hash the cover proxy expects, so the path is all
		// that is needed and the host is re-applied at render time.
		const path = imageProxyPath({
			type: 'thumb',
			path: '/library/metadata/7881/thumb/1770210382',
			provider: 'plex--WBNqQe7f',
			remotely_accessible: false,
			proxy_id: '87978899ff1f68f667e801af645436fe1abe81d8b8c01d4b2451a7ec0f9e1b09'
		} as never);
		expect(path).toBe(
			'/imageproxy/87978899ff1f68f667e801af645436fe1abe81d8b8c01d4b2451a7ec0f9e1b09'
		);
	});

	test('accepts a full imageproxy URL from a provider that sends one', () => {
		expect(
			imageProxyPath('http://media.example:8095/imageproxy/abc123?size=256')
		).toBe('/imageproxy/abc123');
	});

	test('rejects descriptors with no usable token', () => {
		// Anything off-contract is dropped here rather than becoming a 400 from
		// the cover proxy, which only accepts /imageproxy/<token>.
		expect(imageProxyPath({ proxy_id: null } as never)).toBeNull();
		expect(imageProxyPath({ proxy_id: '   ' } as never)).toBeNull();
		expect(imageProxyPath({ path: '/library/metadata/1/thumb/2' } as never)).toBeNull();
	});

	test('rejects tokens the cover proxy would refuse', () => {
		// The cover route allows /^\/imageproxy\/[A-Za-z0-9_-]+$/ only, so a token
		// with a slash or dot would turn every render into a failed request.
		expect(imageProxyPath({ proxy_id: 'a/b' } as never)).toBeNull();
		expect(imageProxyPath({ proxy_id: '../etc/passwd' } as never)).toBeNull();
		expect(imageProxyPath({ proxy_id: 'a.b' } as never)).toBeNull();
	});

	test('rejects a URL that is not an imageproxy path', () => {
		// A stored full URL would leak a private LAN address, and an arbitrary
		// one would turn the tile into a tracking pixel.
		expect(imageProxyPath('http://10.0.0.4:8095/other/abc')).toBeNull();
		expect(imageProxyPath('https://evil.example/x.png')).toBeNull();
		expect(imageProxyPath('not-a-url')).toBeNull();
	});

	test('handles null and empty input', () => {
		expect(imageProxyPath(null)).toBeNull();
		expect(imageProxyPath(undefined)).toBeNull();
		expect(imageProxyPath('')).toBeNull();
	});
});
