import { getCurrentTrack } from '$lib/server/webhook';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	return {
		nowPlaying: locals.user ? await getCurrentTrack().catch(() => null) : null,
		user: locals.user
	};
};
