import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () =>
	Response.json(
		{ status: 'ok' },
		{ headers: { 'Cache-Control': 'no-store' } }
	);
