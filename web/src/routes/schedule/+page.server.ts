import { getActiveSchedule, listSchedules } from '$lib/server/vibe-store';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const [schedules, activeSchedule] = await Promise.all([
		listSchedules().catch(() => []),
		getActiveSchedule().catch(() => null)
	]);
	return { schedules, activeSchedule };
};
