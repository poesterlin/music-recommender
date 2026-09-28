import { sql } from 'drizzle-orm';
import { db } from './db';

/** Keep in sync with the account CLI's lock so both creation paths serialize. */
export const USER_CREATION_LOCK = 734512;

/** Self-registration is an explicit opt-in; account creation otherwise uses the operator CLI. */
export function registrationEnabled(value = process.env.ALLOW_REGISTRATION): boolean {
	return value === 'true';
}

export function maxUsers(value = process.env.MAX_USERS): number {
	if (value === undefined || value === '') return 1;
	const parsed = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < 1) {
		throw new Error('MAX_USERS must be a positive integer');
	}
	return parsed;
}

export async function registrationAvailable(): Promise<boolean> {
	if (!registrationEnabled()) return false;
	const [row] = await db.execute(sql`select count(*)::int as total from "user"`);
	return Number(row?.total ?? 0) < maxUsers();
}
