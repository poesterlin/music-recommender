import { redirect } from '@sveltejs/kit';
import { deleteSessionCookie, invalidateSession } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	if (!event.locals.session) redirect(302, '/login');
	await invalidateSession(event.locals.session.id);
	deleteSessionCookie(event);
	redirect(303, '/login');
};
