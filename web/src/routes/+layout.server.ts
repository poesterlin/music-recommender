import { getCurrentTrack } from '$lib/server/webhook';
import { needsSetup } from '$lib/server/setup/state';
import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	// An install with no library at all has nothing to show, so send it to the
	// wizard rather than an empty home page. An install that already has tracks
	// is left alone even if it has never seen /setup.
	// Manage must remain available before indexing so the analysis profile can
	// be chosen before the first embeddings, and worker keys can be created.
	if (
		locals.user &&
		url.pathname !== '/setup' &&
		url.pathname !== '/manage' &&
		!url.pathname.startsWith('/manage/')
	) {
		let wanted = false;
		try {
			wanted = await needsSetup();
		} catch {
			// If the check cannot run, assume it is not needed rather than
			// trapping a working install behind the wizard.
			wanted = false;
		}
		if (wanted) redirect(302, '/setup');
	}

	return {
		nowPlaying: locals.user ? await getCurrentTrack().catch(() => null) : null,
		user: locals.user
	};
};
