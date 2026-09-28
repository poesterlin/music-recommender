import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { vibeStateTable } from '../schema';
import type { KDerivation } from './derive-k';

/** Row in `vibe_state` holding the first-run setup state. */
const SETUP_KEY = 'setup-v1';

/**
 * A run that claims to be in progress but has not touched its state in this
 * long is assumed dead (the web container restarted mid-run). Without this the
 * UI would sit on "running" forever and never offer to resume.
 */
const RUN_STALE_AFTER_MS = 90_000;

export type StepId = 'environment' | 'library' | 'index' | 'embed' | 'cluster' | 'name' | 'covers';

export type StepStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped';

export type StepState = {
	status: StepStatus;
	/** One line a person can read. Must say what happened, not what it tried. */
	detail: string;
	at: string | null;
};

export type SetupState = {
	version: 1;
	/** A runner is executing right now. */
	running: boolean;
	/** The runner stopped because a step is waiting on something external. */
	paused: boolean;
	/** Every step reached a terminal state. */
	complete: boolean;
	current: StepId | null;
	steps: Record<StepId, StepState>;
	k: KDerivation | null;
	startedAt: string | null;
	finishedAt: string | null;
	updatedAt: string;
};

export const STEP_ORDER: readonly StepId[] = [
	'environment',
	'library',
	'index',
	'embed',
	'cluster',
	'name',
	'covers'
] as const;

export function emptyState(): SetupState {
	const steps = {} as Record<StepId, StepState>;
	for (const id of STEP_ORDER) {
		steps[id] = { status: 'pending', detail: 'Not started', at: null };
	}
	return {
		version: 1,
		running: false,
		paused: false,
		complete: false,
		current: null,
		steps,
		k: null,
		startedAt: null,
		finishedAt: null,
		updatedAt: new Date().toISOString()
	};
}

/**
 * Validate a persisted state, or return null if it cannot be trusted.
 *
 * A partially-written or hand-edited row must fall back to a clean state rather
 * than be partially believed: a step reported as `done` that never ran would
 * silently skip work on the next attempt.
 */
export function coerceState(value: unknown): SetupState | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Partial<SetupState>;
	if (raw.version !== 1 || !raw.steps) return null;
	const base = emptyState();
	const steps = { ...base.steps };
	for (const id of STEP_ORDER) {
		const step = (raw.steps as Record<string, StepState>)[id];
		if (!step || typeof step.detail !== 'string') return null;
		if (!['pending', 'running', 'waiting', 'done', 'failed', 'skipped'].includes(step.status)) {
			return null;
		}
		steps[id] = { status: step.status, detail: step.detail, at: step.at ?? null };
	}
	return {
		...base,
		running: raw.running === true,
		paused: raw.paused === true,
		complete: raw.complete === true,
		current: (raw.current ?? null) as StepId | null,
		steps,
		k: raw.k ?? null,
		startedAt: raw.startedAt ?? null,
		finishedAt: raw.finishedAt ?? null,
		updatedAt: raw.updatedAt ?? base.updatedAt
	};
}

export async function readState(): Promise<SetupState> {
	const rows = await db
		.select({ value: vibeStateTable.value })
		.from(vibeStateTable)
		.where(eq(vibeStateTable.key, SETUP_KEY));
	if (!rows.length) return emptyState();
	const parsed = coerceState(safeParse(rows[0].value));
	if (!parsed) return emptyState();

	// Recover from a runner that died with the process.
	if (parsed.running) {
		const age = Date.now() - new Date(parsed.updatedAt).getTime();
		if (Number.isFinite(age) && age > RUN_STALE_AFTER_MS) {
			return {
				...parsed,
				running: false,
				current: null,
				steps: Object.fromEntries(
					Object.entries(parsed.steps).map(([id, step]) => [
						id,
						step.status === 'running'
							? {
									status: 'pending' as StepStatus,
									detail: 'Interrupted by a restart — safe to run again',
									at: step.at
								}
							: step
					])
				) as Record<StepId, StepState>
			};
		}
	}
	return parsed;
}

export async function writeState(state: SetupState): Promise<SetupState> {
	const next: SetupState = { ...state, updatedAt: new Date().toISOString() };
	await db
		.insert(vibeStateTable)
		.values({ key: SETUP_KEY, value: JSON.stringify(next) })
		.onConflictDoUpdate({
			target: vibeStateTable.key,
			set: { value: JSON.stringify(next), updatedAt: sql`now()` }
		});
	return next;
}

/**
 * Read-modify-write one step. Serialised in-process because the setup runner
 * and the API endpoints both mutate this row.
 */
let writeChain: Promise<unknown> = Promise.resolve();
export function mutateState(mutate: (state: SetupState) => SetupState): Promise<SetupState> {
	const run = writeChain.then(async () => writeState(mutate(await readState())));
	// Keep the chain alive even if one mutation rejects.
	writeChain = run.catch(() => undefined);
	return run;
}

export function setStep(state: SetupState, id: StepId, patch: Partial<StepState>): SetupState {
	return {
		...state,
		steps: {
			...state.steps,
			[id]: { ...state.steps[id], ...patch, at: patch.at ?? new Date().toISOString() }
		}
	};
}

export function isTerminal(status: StepStatus): boolean {
	return status === 'done' || status === 'failed' || status === 'skipped';
}

/** Every step settled, with nothing left waiting. */
export function isComplete(state: SetupState): boolean {
	return STEP_ORDER.every((id) => isTerminal(state.steps[id].status));
}

/**
 * True when this install has never had a library, and so has nothing to show.
 *
 * Deliberately not "has the wizard been run": an install that predates /setup
 * must not be locked out of the app by the redirect. The test is whether there
 * is any library at all — a track row, or a clustering generation.
 */
export async function needsSetup(): Promise<boolean> {
	const state = await readState();
	if (state.complete && state.finishedAt !== null) return false;

	const rows = (await db.execute(sql`
		SELECT
			(SELECT count(*)::int FROM track) AS tracks,
			(SELECT count(*)::int FROM cluster_run) AS runs
	`)) as unknown as Array<{ tracks: number; runs: number }>;

	const tracks = Number(rows[0]?.tracks ?? 0);
	const runs = Number(rows[0]?.runs ?? 0);
	return tracks === 0 && runs === 0;
}

function safeParse(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
