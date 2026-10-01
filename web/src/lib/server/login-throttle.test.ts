import { expect, test } from 'bun:test';
import { createLoginThrottle } from './login-throttle';

test('limits each address to five attempts and allows it again at expiry', () => {
	const consume = createLoginThrottle();
	for (let i = 0; i < 5; i++) expect(consume('client-a', 0)).toBe(0);
	expect(consume('client-a', 1)).toBe(60);
	expect(consume('client-a', 59_001)).toBe(1);
	expect(consume('client-b', 59_001)).toBe(0);
	expect(consume('client-a', 60_000)).toBe(0);
	// Expiry is per client, even between periodic cleanup sweeps.
	expect(consume('client-b', 119_001)).toBe(0);
});

test('bounds address storage without letting new addresses evict blocked ones', () => {
	const consume = createLoginThrottle();
	for (let i = 0; i < 10_000; i++) expect(consume(`client-${i}`, 0)).toBe(0);
	expect(consume('new-client', 0)).toBe(60);
	for (let i = 0; i < 4; i++) expect(consume('client-0', 0)).toBe(0);
	expect(consume('client-0', 0)).toBe(60);
	expect(consume('new-client', 60_000)).toBe(0);
});
