import { fail, redirect } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '$lib/server/db';
import {
	createSession,
	generateId,
	generateSessionToken,
	hashPassword,
	safeRedirectPath,
	setSessionCookie,
	validatePassword,
	validateUsername
} from '$lib/server/auth';
import { userTable } from '$lib/server/schema';
import {
	maxUsers,
	registrationAvailable,
	registrationEnabled,
	USER_CREATION_LOCK
} from '$lib/server/registration';
import type { Actions, PageServerLoad } from './$types';

const registerSchema = z.object({
	username: z.string(),
	password: z.string(),
	redirect: z.string().optional()
});

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) redirect(302, '/');
	if (!(await registrationAvailable())) redirect(302, '/login');
	return {};
};

export const actions: Actions = {
	register: async (event) => {
		if (!registrationEnabled()) redirect(303, '/login');
		const form = Object.fromEntries(await event.request.formData());
		const parsed = registerSchema.safeParse(form);
		if (!parsed.success) return fail(400, { message: 'Enter valid account details.' });

		const username = parsed.data.username.trim();
		const password = parsed.data.password;
		if (!validateUsername(username) || !validatePassword(password)) {
			return fail(400, {
				message: 'Username must be 3–31 characters and password at least 8 characters.'
			});
		}

		const userId = generateId();
		let result: 'created' | 'full' | 'taken';
		try {
			const passwordHash = await hashPassword(password);
			result = await db.transaction(async (tx) => {
				await tx.execute(sql`select pg_advisory_xact_lock(${USER_CREATION_LOCK}, 1)`);
				const [count] = await tx.execute(sql`select count(*)::int as total from "user"`);
				if (Number(count?.total ?? 0) >= maxUsers()) return 'full';
				const [existing] = await tx
					.select({ id: userTable.id })
					.from(userTable)
					.where(eq(userTable.username, username));
				if (existing) return 'taken';
				await tx.insert(userTable).values({
					id: userId,
					username,
					passwordHash,
					createdAt: new Date(),
					lastLogin: new Date()
				});
				return 'created';
			});
		} catch {
			return fail(500, { message: 'Could not create the account.' });
		}
		if (result === 'full') redirect(303, '/login');
		if (result === 'taken') return fail(400, { message: 'That username is already in use.' });

		const sessionToken = generateSessionToken();
		const session = await createSession(sessionToken, userId);
		setSessionCookie(event, sessionToken, session.expiresAt);
		redirect(302, safeRedirectPath(parsed.data.redirect));
	}
};
