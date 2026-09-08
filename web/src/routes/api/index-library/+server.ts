import { indexLibrary } from '$lib/server/index-library';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
	try {
		const count = await indexLibrary();
		return Response.json({ success: true, count });
	} catch (error) {
		console.error('Index library failed:', error);
		return Response.json({ success: false, error: String(error) }, { status: 500 });
	}
};
