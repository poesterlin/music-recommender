import { describe, expect, test } from 'bun:test';
import { isHumanNamed } from './active-clusters';

describe('isHumanNamed', () => {
	test('accepts a name a person typed', () => {
		expect(isHumanNamed('Driving punk rock')).toBe(true);
		expect(isHumanNamed('  Warm acoustic  ')).toBe(true);
	});

	test('rejects a blank or reset name', () => {
		expect(isHumanNamed('')).toBe(false);
		expect(isHumanNamed('   ')).toBe(false);
		expect(isHumanNamed(null)).toBe(false);
		expect(isHumanNamed(undefined)).toBe(false);
	});

	test('rejects a name carried over from a previous generation', () => {
		// The match script seeds a new run with the old generation's names plus
		// a provenance marker. Those describe a different numbering and must
		// not be presented as if a person chose them.
		expect(isHumanNamed('Silky Sophisticated Pop & R&B · old #0 (100%)')).toBe(false);
		expect(isHumanNamed('Melodic Alternative & British Rock · split B · old #48')).toBe(false);
		expect(isHumanNamed('Raw Rap, Skits & Spoken Tracks · old #0')).toBe(false);
	});

	test('does not reject an ordinary name that happens to contain a dot', () => {
		expect(isHumanNamed('Slow jam. Old school R&B')).toBe(true);
		expect(isHumanNamed('Feels like old #1')).toBe(true);
	});
});
