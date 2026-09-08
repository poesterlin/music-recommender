import { indexLibrary } from '$lib/server/index-library';
import { recordJobRun } from '$lib/server/job-log';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
	try {
		const count = await indexLibrary();
		await recordJobRun('index-library', true, `${count} new tracks`);
		return Response.json({ success: true, count });
	} catch (error) {
		console.error('Index library failed:', error);
		await recordJobRun('index-library', false, String(error).slice(0, 200));
		return Response.json({ success: false, error: String(error) }, { status: 500 });
	}
};
