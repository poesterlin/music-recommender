import { indexLibrary } from '$lib/server/index-library';
import { recordJobRun } from '$lib/server/job-log';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals }) => {
	const source = locals.method === 'service' ? 'automatic' : 'manual';
	try {
		const { fetched, added, existing, failed } = await indexLibrary();
		// Report what actually changed rather than the library size, so a
		// routine run is distinguishable from a real import.
		const detail = added > 0 ? `${added} new` : `no new tracks, ${existing} already indexed`;
		await recordJobRun('index-library', failed === 0, detail, source);
		return Response.json({ success: failed === 0, fetched, added, existing, failed });
	} catch (error) {
		console.error('Index library failed:', error);
		await recordJobRun('index-library', false, String(error).slice(0, 200), source);
		return Response.json({ success: false, error: String(error) }, { status: 500 });
	}
};
