import { addArtistByNameToLidarr } from '$lib/server/add-artists';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = (await request.json()) as { name?: string };
		const artistName = body.name?.trim();

		if (!artistName) {
			return Response.json(
				{ success: false, message: 'Artist name is required' },
				{ status: 400 }
			);
		}

		const result = await addArtistByNameToLidarr(artistName);
		return Response.json(result, { status: result.success ? 200 : 500 });
	} catch (error) {
		return Response.json(
			{ success: false, message: 'Invalid request body', error: String(error) },
			{ status: 400 }
		);
	}
};
