import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { hash, verify } from '@node-rs/argon2';
import type { RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { sessionTable, userTable, type Session, type User } from '$lib/server/schema';

const DAY_IN_MS = 24 * 60 * 60 * 1_000;
const SESSION_DAYS = 30;
export const sessionCookieName =
	process.env.NODE_ENV === 'production' ? '__Host-music-auth-session' : 'music-auth-session';

export type AuthUser = Pick<User, 'id' | 'username'>;
export type AuthMethod = 'session' | 'service';
export type AuthState = {
	user: AuthUser | null;
	session: Session | null;
	method: AuthMethod | null;
};

export const serviceUser: AuthUser = { id: 'service', username: 'service' };

// Outbound Home Assistant webhook authentication used by legacy playback
// fallback. This is intentionally separate from inbound app authentication.
export const authHeaders = new Headers({
	Accept: 'application/json',
	'Content-Type': 'application/json',
	Authorization: `Bearer ${process.env.TOKEN ?? ''}`
});

function sha256(value: string): string {
	return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function constantTimeEqual(left: string, right: string): boolean {
	const leftDigest = createHash('sha256').update(left, 'utf8').digest();
	const rightDigest = createHash('sha256').update(right, 'utf8').digest();
	return timingSafeEqual(leftDigest, rightDigest);
}

export function requestCredential(request: Request): string | null {
	const headerKey = request.headers.get('x-api-key')?.trim();
	if (headerKey) return headerKey;
	const authorization = request.headers.get('authorization')?.trim() ?? '';
	return authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : null;
}

export function matchesConfiguredToken(request: Request, variable: string): boolean {
	const expected = process.env[variable]?.trim();
	const provided = requestCredential(request);
	return Boolean(expected && provided && constantTimeEqual(expected, provided));
}

export function generateId(): string {
	return randomBytes(18).toString('base64url');
}

export function generateSessionToken(): string {
	return randomBytes(32).toString('base64url');
}

export function validateUsername(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length >= 3 && value.trim().length <= 31;
}

export function validatePassword(value: unknown): value is string {
	return typeof value === 'string' && value.length >= 8 && value.length <= 255;
}

export function safeRedirectPath(value: unknown, fallback = '/'): string {
	if (
		typeof value !== 'string' ||
		!value.startsWith('/') ||
		value.startsWith('//') ||
		value.includes('\\') ||
		/[\r\n]/.test(value)
	) {
		return fallback;
	}
	return value;
}

export async function hashPassword(password: string): Promise<string> {
	return hash(password, {
		memoryCost: 19_456,
		timeCost: 2,
		outputLen: 32,
		parallelism: 1
	});
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
	try {
		return await verify(passwordHash, password, {
			memoryCost: 19_456,
			timeCost: 2,
			outputLen: 32,
			parallelism: 1
		});
	} catch {
		return false;
	}
}

export async function createSession(token: string, userId: string): Promise<Session> {
	const session: Session = {
		id: sha256(token),
		userId,
		expiresAt: new Date(Date.now() + DAY_IN_MS * SESSION_DAYS)
	};
	await db.insert(sessionTable).values(session);
	return session;
}

export async function validateSessionToken(token: string): Promise<{
	session: Session | null;
	user: AuthUser | null;
}> {
	const [result] = await db
		.select({ user: { id: userTable.id, username: userTable.username }, session: sessionTable })
		.from(sessionTable)
		.innerJoin(userTable, eq(sessionTable.userId, userTable.id))
		.where(eq(sessionTable.id, sha256(token)));

	if (!result) return { session: null, user: null };
	if (Date.now() >= result.session.expiresAt.getTime()) {
		await db.delete(sessionTable).where(eq(sessionTable.id, result.session.id));
		return { session: null, user: null };
	}

	if (Date.now() >= result.session.expiresAt.getTime() - DAY_IN_MS * 15) {
		result.session.expiresAt = new Date(Date.now() + DAY_IN_MS * SESSION_DAYS);
		await db
			.update(sessionTable)
			.set({ expiresAt: result.session.expiresAt })
			.where(eq(sessionTable.id, result.session.id));
	}
	return result;
}

export async function invalidateSession(sessionId: string): Promise<void> {
	await db.delete(sessionTable).where(eq(sessionTable.id, sessionId));
}

export function setSessionCookie(event: RequestEvent, token: string, expiresAt: Date): void {
	event.cookies.set(sessionCookieName, token, {
		httpOnly: true,
		secure: event.url.protocol === 'https:',
		sameSite: 'lax',
		path: '/',
		expires: expiresAt
	});
}

export function deleteSessionCookie(event: RequestEvent): void {
	event.cookies.delete(sessionCookieName, { path: '/' });
}

export async function authenticateRequest(event: RequestEvent): Promise<AuthState> {
	const sessionToken = event.cookies.get(sessionCookieName);
	if (!sessionToken) return { user: null, session: null, method: null };
	const result = await validateSessionToken(sessionToken);
	if (!result.session || !result.user) {
		deleteSessionCookie(event);
		return { user: null, session: null, method: null };
	}
	setSessionCookie(event, sessionToken, result.session.expiresAt);
	return { user: result.user, session: result.session, method: 'session' };
}

export type { Session, User };
