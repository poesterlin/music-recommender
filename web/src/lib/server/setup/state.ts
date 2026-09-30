import { sql } from 'drizzle-orm';
import { db } from '../db';
import type { KDerivation } from './derive-k';

export type StepId = 'environment' | 'library' | 'index' | 'embed' | 'cluster' | 'name' | 'covers';
export type StepStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped';
export type StepState = { status: StepStatus; detail: string };
export type SetupState = {
	running: boolean;
	complete: boolean;
	current: StepId | null;
	steps: Record<StepId, StepState>;
	k: KDerivation | null;
};

export const STEP_ORDER: readonly StepId[] = [
	'environment',
	'library',
	'index',
	'embed',
	'cluster',
	'name',
	'covers'
];

/** Existing libraries are never redirected into first-run setup. */
export async function needsSetup(): Promise<boolean> {
	const [row] = await db.execute(sql`
		SELECT EXISTS (SELECT 1 FROM track) OR EXISTS (SELECT 1 FROM cluster_run) AS ready
	`);
	return !row.ready;
}
