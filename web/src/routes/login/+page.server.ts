import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '$lib/server/db';
import {
	createSession,
	generateSessionToken,
	safeRedirectPath,
	setSessionCookie,
	validatePassword,
	validateUsername,
	verifyPassword
} from '$lib/server/auth';
import { userTable } from '$lib/server/schema';
import type { Actions, PageServerLoad } from './$types';

const loginSchema = z.object({
	username: z.string(),
	password: z.string(),
	redirect: z.string().optional()
});

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) redirect(302, '/');
	return {};
};

export const actions: Actions = {
	login: async (event) => {
		const form = Object.fromEntries(await event.request.formData());
		const parsed = loginSchema.safeParse(form);
		if (!parsed.success) return fail(400, { message: 'Enter a username and password.' });

		const username = parsed.data.username.trim();
		const { password } = parsed.data;
		if (!validateUsername(username) || !validatePassword(password)) {
			return fail(400, { message: 'Enter a valid username and password.' });
		}

		const [existingUser] = await db
			.select()
			.from(userTable)
			.where(eq(userTable.username, username));
		if (!existingUser || !(await verifyPassword(existingUser.passwordHash, password))) {
			return fail(400, { message: 'Invalid username or password.' });
		}

		const sessionToken = generateSessionToken();
		const session = await createSession(sessionToken, existingUser.id);
		setSessionCookie(event, sessionToken, session.expiresAt);
		await db
			.update(userTable)
			.set({ lastLogin: new Date() })
			.where(eq(userTable.id, existingUser.id));
		redirect(302, safeRedirectPath(parsed.data.redirect));
	}
};
