import { recommend, validateTrackUris } from '$lib/server/recomendation-engine';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as {
		seedUris?: unknown;
		limit?: unknown;
	} | null;
	const limit = body?.limit ?? 30;
	const seedUris = Array.isArray(body?.seedUris)
		? [
				...new Set(
					body.seedUris.filter((uri): uri is string => typeof uri === 'string' && uri.length > 0)
				)
			]
		: [];

	if (
		!body ||
		!Number.isSafeInteger(limit) ||
		(limit as number) < 1 ||
		(limit as number) > 100 ||
		seedUris.length < 1 ||
		seedUris.length > 10 ||
		seedUris.some((uri) => uri.length > 2048)
	) {
		return Response.json(
			{ success: false, error: 'Provide 1-10 seed URIs and a limit between 1 and 100.' },
			{ status: 400 }
		);
	}

	const recommendations = await recommend({
		seedUris,
		limit: limit as number,
		alphaNow: 0.7,
		maxPerArtist: 3
	});
	const tracks = await validateTrackUris(recommendations);
	return Response.json({ success: true, tracks });
};
