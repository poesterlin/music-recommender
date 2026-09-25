import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
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
import type { Actions, PageServerLoad } from './$types';

const registerSchema = z.object({
	username: z.string(),
	password: z.string(),
	email: z.string().email().optional().or(z.literal('')),
	redirect: z.string().optional()
});

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) redirect(302, '/');
	return {};
};

export const actions: Actions = {
	register: async (event) => {
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

		const [existing] = await db
			.select({ id: userTable.id })
			.from(userTable)
			.where(eq(userTable.username, username));
		if (existing) return fail(400, { message: 'That username is already in use.' });

		const userId = generateId();
		try {
			await db.insert(userTable).values({
				id: userId,
				email: parsed.data.email?.trim() || null,
				username,
				passwordHash: await hashPassword(password),
				createdAt: new Date(),
				lastLogin: new Date()
			});
		} catch {
			return fail(500, { message: 'Could not create the account.' });
		}

		const sessionToken = generateSessionToken();
		const session = await createSession(sessionToken, userId);
		setSessionCookie(event, sessionToken, session.expiresAt);
		redirect(302, safeRedirectPath(parsed.data.redirect));
	}
};
