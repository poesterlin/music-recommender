import { fail, redirect } from '@sveltejs/kit';
import { createApiKey, listApiKeys, revokeApiKey, type ApiKeyView } from '$lib/server/api-keys';
import type { ApiKeyScope } from '$lib/server/schema';
import type { Actions, PageServerLoad } from './$types';

function dateValue(value: Date | null): string | null {
	return value?.toISOString() ?? null;
}

function pageKey(key: ApiKeyView) {
	return {
		id: key.id,
		name: key.name,
		scope: key.scope,
		keyPrefix: key.keyPrefix,
		createdAt: dateValue(key.createdAt),
		lastUsedAt: dateValue(key.lastUsedAt),
		expiresAt: dateValue(key.expiresAt),
		revokedAt: dateValue(key.revokedAt),
		active: key.active
	};
}

function parseExpiry(value: FormDataEntryValue | null): number | null | undefined {
	if (value === null || value === '' || value === 'never') return null;
	const days = Number(value);
	return [30, 90, 365].includes(days) ? days : undefined;
}

function parseScope(value: FormDataEntryValue | null): ApiKeyScope | undefined {
	return value === 'worker' || value === 'playback' ? value : undefined;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login?redirect=%2Fsettings');
	return {
		workerUrl: url.origin,
		keys: (await listApiKeys(locals.user.id)).map(pageKey)
	};
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		if (!locals.user) return fail(401, { message: 'Authentication required.' });

		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const scope = parseScope(form.get('scope'));
		const expiresInDays = parseExpiry(form.get('expiresInDays'));
		const expiryValue = String(form.get('expiresInDays') ?? 'never');
		const values = { name, scope: String(form.get('scope') ?? ''), expiresInDays: expiryValue };

		if (!name || name.length > 80) {
			return fail(400, { message: 'Give the key a name between 1 and 80 characters.', values });
		}
		if (!scope) {
			return fail(400, { message: 'Choose either Worker or Home Assistant playback.', values });
		}
		if (expiresInDays === undefined) {
			return fail(400, { message: 'Choose a valid expiration period.', values });
		}

		const created = await createApiKey(locals.user.id, name, scope, expiresInDays);
		return {
			createdKey: {
				...pageKey(created.key),
				secret: created.secret
			},
			message: 'API key created. Copy it now; it will not be shown again.'
		};
	},
	revoke: async ({ locals, request }) => {
		if (!locals.user) return fail(401, { message: 'Authentication required.' });
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
			return fail(400, { message: 'That API key could not be revoked.' });
		}
		if (!(await revokeApiKey(locals.user.id, id))) {
			return fail(404, { message: 'That API key was already revoked or does not exist.' });
		}
		return { revoked: true, message: 'API key revoked.' };
	}
};
