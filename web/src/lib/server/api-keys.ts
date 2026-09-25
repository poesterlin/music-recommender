import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { requestCredential } from '$lib/server/auth';
import { apiKeyTable, type ApiKey, type ApiKeyScope } from '$lib/server/schema';

const API_KEY_PREFIX = 'mrk_';
const DAY_IN_MS = 24 * 60 * 60 * 1_000;

export type ApiKeyView = Omit<ApiKey, 'keyHash'> & {
	active: boolean;
};

export type CreatedApiKey = {
	key: ApiKeyView;
	secret: string;
};

function hashApiKey(value: string): string {
	return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isActive(key: ApiKey, now = new Date()): boolean {
	return !key.revokedAt && (!key.expiresAt || key.expiresAt.getTime() > now.getTime());
}

function toView(key: ApiKey, now = new Date()): ApiKeyView {
	const { keyHash: _keyHash, ...view } = key;
	return { ...view, active: isActive(key, now) };
}

export async function createApiKey(
	userId: string,
	name: string,
	scope: ApiKeyScope,
	expiresInDays: number | null = null
): Promise<CreatedApiKey> {
	const secret = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
	const expiresAt = expiresInDays
		? new Date(Date.now() + expiresInDays * DAY_IN_MS)
		: null;
	const [key] = await db
		.insert(apiKeyTable)
		.values({
			id: randomBytes(18).toString('base64url'),
			userId,
			name,
			scope,
			keyPrefix: secret.slice(0, 12),
			keyHash: hashApiKey(secret),
			expiresAt
		})
		.returning();

	return { key: toView(key), secret };
}

export async function listApiKeys(userId: string): Promise<ApiKeyView[]> {
	const keys = await db
		.select()
		.from(apiKeyTable)
		.where(eq(apiKeyTable.userId, userId))
		.orderBy(desc(apiKeyTable.createdAt));
	return keys.map((key) => toView(key));
}

export async function revokeApiKey(userId: string, keyId: string): Promise<boolean> {
	const [revoked] = await db
		.update(apiKeyTable)
		.set({ revokedAt: new Date() })
		.where(
			and(
				eq(apiKeyTable.id, keyId),
				eq(apiKeyTable.userId, userId),
				isNull(apiKeyTable.revokedAt)
			)
		)
		.returning({ id: apiKeyTable.id });
	return Boolean(revoked);
}

/** Authenticate a scoped, database-backed API key without exposing its secret. */
export async function authenticateApiKey(
	request: Request,
	scope: ApiKeyScope
): Promise<ApiKey | null> {
	const credential = requestCredential(request);
	if (!credential || credential.length > 256) return null;

	const [key] = await db
		.select()
		.from(apiKeyTable)
		.where(eq(apiKeyTable.keyHash, hashApiKey(credential)))
		.limit(1);
	if (!key || key.scope !== scope || !isActive(key)) return null;

	await db
		.update(apiKeyTable)
		.set({ lastUsedAt: new Date() })
		.where(eq(apiKeyTable.id, key.id));
	return key;
}
