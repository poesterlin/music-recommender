import { ARTISTS_TO_ADD, importArtistsToLidarr } from '$lib/server/add-artists';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
	try {
		const result = await importArtistsToLidarr(ARTISTS_TO_ADD);
		return Response.json({
			success: true,
			imported: result.success,
			failed: result.failed,
			results: result.results
		});
	} catch (error) {
		return Response.json(
			{ success: false, message: 'Failed to import artists', error: String(error) },
			{ status: 500 }
		);
	}
};
