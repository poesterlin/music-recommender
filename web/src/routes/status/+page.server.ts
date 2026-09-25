import { getPipelineStatus } from '$lib/server/pipeline-status';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => getPipelineStatus();
