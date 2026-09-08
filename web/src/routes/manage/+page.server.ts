import { ARTISTS_TO_ADD } from '$lib/server/add-artists';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	return { defaultArtistCount: ARTISTS_TO_ADD.length };
};
