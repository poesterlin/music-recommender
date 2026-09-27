import { getSetupState } from '$lib/server/setup';
import { STEPS } from '$lib/server/setup/steps';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const state = await getSetupState();
	return {
		state,
		// Titles and blurbs live next to the step definitions so the server
		// cannot drift from what the page claims each step does.
		steps: STEPS.map((step) => ({ id: step.id, title: step.title, blurb: step.blurb }))
	};
};
