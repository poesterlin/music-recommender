import { getCurrentTrack } from '$lib/server/webhook';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async () => {
	return { nowPlaying: await getCurrentTrack().catch(() => null) };
};
