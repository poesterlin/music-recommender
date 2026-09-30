import type { SetupState, StepId, StepState } from './state';
import { STEPS, stepById, type StepOutcome } from './steps';

// Only the current operation is process-local. Readiness comes from live data;
// a restart needs no persisted progress recovery or stale-run heuristics.
let active: StepId | null = null;
let failure: { id: StepId; outcome: StepOutcome } | null = null;

export async function getSetupState(): Promise<SetupState> {
	const entries = await Promise.all(
		STEPS.map(async (step) => {
			let outcome: StepOutcome;
			try {
				outcome = await step.probe();
			} catch (error) {
				outcome = { status: 'failed', detail: `Could not check: ${String(error).slice(0, 140)}` };
			}
			return [step.id, outcome] as const;
		})
	);
	const steps = Object.fromEntries(entries) as Record<StepId, StepState>;
	const current = active;
	if (failure) steps[failure.id] = failure.outcome;
	if (current) steps[current] = { status: 'running', detail: 'Working…' };
	return {
		running: current !== null,
		current,
		complete:
			Object.values(steps).every((step) => step.status === 'done' || step.status === 'skipped') &&
			!current,
		steps,
		k: entries.find(([id]) => id === 'cluster')?.[1].k ?? null
	};
}

/** Run one explicitly requested action. No automatic pipeline or retry loop. */
export function runSetupStep(id: StepId): boolean {
	const step = stepById(id);
	if (!step || active) return false;
	active = id;
	failure = null;
	void Promise.resolve()
		.then(() => step.run())
		.then((outcome) => {
			if (outcome.status === 'failed') failure = { id, outcome };
		})
		.catch((error) => {
			failure = { id, outcome: { status: 'failed', detail: String(error).slice(0, 200) } };
		})
		.finally(() => {
			active = null;
		});
	return true;
}
