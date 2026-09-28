import { getCenteredSpaceState, repairCenteredSpace } from '$lib/server/centered-space';
import type { RequestHandler } from './$types';

/**
 * Repair a centered space that is missing or incomplete.
 *
 * This is the in-app equivalent of `bun run db:ensure-centered`, for the case
 * where an operator should not need a terminal to recover. Session-only: it
 * writes to every embedded track.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (locals.method === 'service') {
		return Response.json({ error: 'session required' }, { status: 403 });
	}

	const url = new URL(request.url);
	const dryRun = url.searchParams.get('dryRun') === '1';

	try {
		const before = await getCenteredSpaceState();
		if (!before.needsSpace && !before.needsBackfill && !before.tooFewEmbeddings) {
			return Response.json({
				success: true,
				alreadyHealthy: true,
				state: before,
				message: 'Centered space is present and every embedding is derived from it.'
			});
		}

		const result = await repairCenteredSpace({ dryRun });

		if (!result.ok) {
			return Response.json(
				{
					success: false,
					...result,
					state: await getCenteredSpaceState(),
					error: result.skipped ?? 'the centered space could not be repaired'
				},
				{ status: 409 }
			);
		}

		return Response.json({
			success: true,
			...result,
			state: await getCenteredSpaceState(),
			message: result.spaceCreated
				? `Created space v${result.spaceVersion} and centered ${result.rowsCentered.toLocaleString()} embeddings.`
				: `Centered ${result.rowsCentered.toLocaleString()} embeddings against v${result.spaceVersion}.`
		});
	} catch (error) {
		console.error('Centered space repair failed:', error);
		return Response.json(
			{ success: false, error: error instanceof Error ? error.message : String(error) },
			{ status: 500 }
		);
	}
};

/** Whether a repair is needed, so a page can offer the action before it is taken. */
export const GET: RequestHandler = async () => {
	const state = await getCenteredSpaceState();
	return Response.json({
		success: true,
		state,
		needsRepair: state.needsSpace || state.needsBackfill,
		tooFewEmbeddings: state.tooFewEmbeddings
	});
};
