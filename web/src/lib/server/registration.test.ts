import { describe, expect, test } from 'bun:test';
import { maxUsers, registrationEnabled } from './registration';

describe('registration settings', () => {
	test('self-registration requires an explicit opt-in', () => {
		const previous = process.env.ALLOW_REGISTRATION;
		delete process.env.ALLOW_REGISTRATION;
		try {
			expect(registrationEnabled()).toBe(false);
		} finally {
			if (previous !== undefined) process.env.ALLOW_REGISTRATION = previous;
		}
		expect(registrationEnabled('false')).toBe(false);
		expect(registrationEnabled('TRUE')).toBe(false);
		expect(registrationEnabled('true')).toBe(true);
	});

	test('the user cap defaults to one and rejects invalid values', () => {
		const previous = process.env.MAX_USERS;
		delete process.env.MAX_USERS;
		try {
			expect(maxUsers()).toBe(1);
		} finally {
			if (previous !== undefined) process.env.MAX_USERS = previous;
		}
		expect(maxUsers('3')).toBe(3);
		for (const value of ['0', '-1', '1.5', 'Infinity', 'abc', '9007199254740992']) {
			expect(() => maxUsers(value)).toThrow('MAX_USERS must be a positive integer');
		}
	});
});
