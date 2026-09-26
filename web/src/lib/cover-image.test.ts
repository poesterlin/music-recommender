import { describe, expect, test } from 'bun:test';
import { coverUrl } from './cover-image';

describe('coverUrl', () => {
	test('builds a proxied path so private hosts are never exposed', () => {
		const path = '/imageproxy/3b28cf13ec2d702d987c7ffdc0135b8f1d6db4dcb4057ecbd52492817091fb71';
		expect(coverUrl(path, 256)).toBe(`/api/cover?path=${encodeURIComponent(path)}&size=256`);
	});

	test('rejects anything that is not an imageproxy path', () => {
		// A stored full URL would let a bad row turn the tile into an SSRF or
		// tracking-pixel vector, so anything off-contract is dropped.
		expect(coverUrl('http://10.0.0.4:8095/imageproxy/abc')).toBeNull();
		expect(coverUrl('https://evil.example/x.png')).toBeNull();
		expect(coverUrl('/etc/passwd')).toBeNull();
	});

	test('handles null and empty input', () => {
		expect(coverUrl(null)).toBeNull();
		expect(coverUrl(undefined)).toBeNull();
		expect(coverUrl('')).toBeNull();
	});

	test('defaults to 256px', () => {
		const path = '/imageproxy/abc';
		expect(coverUrl(path)).toContain('size=256');
	});
});
