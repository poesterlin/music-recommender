import { readState, mutateState, setStep, isTerminal, STEP_ORDER, emptyState } from './state';
import type { SetupState, StepId } from './state';
import { STEPS, stepById, counts, type StepOutcome } from './steps';
import { deriveClusterCount } from './derive-k';

/** How long to wait before re-checking a step that is blocked on the worker. */
const WAITING_RETRY_MS = 60_000;

let active: Promise<SetupState> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function clearRetry(): void {
	if (retryTimer) {
		clearTimeout(retryTimer);
		retryTimer = null;
	}
}

/**
 * Current state, with pending steps re-probed so the page shows live numbers
 * (how many tracks are analysed, what k will be) rather than stale text.
 *
 * Probing only refreshes steps that have not run. A finished step keeps the
 * result it actually produced.
 */
export async function getSetupState(): Promise<SetupState> {
	const state = await readState();
	if (state.running) return state;

	for (const step of STEPS) {
		if (state.steps[step.id].status !== 'pending') continue;
		try {
			const outcome = await step.probe();
			const next = setStep(state, step.id, {
				status: outcome.status,
				detail: outcome.detail,
				at: null
			});
			if (outcome.k) next.k = outcome.k;
			await mutateState((current) => {
				// Re-read inside the mutation so a step that started running in
				// the meantime is not dragged back to pending.
				if (current.steps[step.id].status !== 'pending') return current;
				const updated = setStep(current, step.id, {
					status: outcome.status,
					detail: outcome.detail
				});
				if (outcome.k) updated.k = outcome.k;
				return updated;
			});
			state.steps[step.id] = next.steps[step.id];
			if (outcome.k) state.k = outcome.k;
		} catch (error) {
			await mutateState((current) =>
				setStep(current, step.id, {
					status: 'pending',
					detail: `Could not check: ${String(error).slice(0, 100)}`
				})
			);
		}
	}
	return readState();
}

async function runStep(step: (typeof STEPS)[number]): Promise<StepOutcome> {
	await mutateState((state) => ({
		...setStep(state, step.id, { status: 'running', detail: 'Working…' }),
		current: step.id as StepId
	}));
	try {
		return await step.run();
	} catch (error) {
		return { status: 'failed', detail: String(error).slice(0, 200) };
	}
}

async function execute(): Promise<SetupState> {
	await mutateState((state) => ({
		...state,
		running: true,
		paused: false,
		complete: false,
		startedAt: state.startedAt ?? new Date().toISOString(),
		finishedAt: null
	}));

	for (const step of STEPS) {
		const state = await readState();
		if (isTerminal(state.steps[step.id].status)) continue;

		// The derive is cheap and lets the UI show k before the long step runs.
		if (step.id === 'cluster' && !state.k) {
			const c = await counts();
			const d = deriveClusterCount(c.clusterable);
			await mutateState((s) => ({ ...s, k: d }));
		}

		const outcome = await runStep(step);
		await mutateState((s) => {
			const next = setStep(s, step.id, { status: outcome.status, detail: outcome.detail });
			if (outcome.k) next.k = outcome.k;
			return next;
		});

		if (outcome.status === 'waiting') {
			// Blocked on the embedding worker, which can take hours. Stop here
			// and re-check later rather than spinning, and do not require a
			// browser tab to stay open for the run to finish.
			await mutateState((s) => ({ ...s, running: false, paused: true, current: null }));
			clearRetry();
			retryTimer = setTimeout(() => {
				retryTimer = null;
				void startSetup({ background: true }).catch(() => undefined);
			}, WAITING_RETRY_MS);
			return readState();
		}
	}

	clearRetry();
	await mutateState((s) => ({
		...s,
		running: false,
		paused: false,
		complete: true,
		current: null,
		finishedAt: new Date().toISOString()
	}));
	return readState();
}

/**
 * Start (or continue) the automatic run. Idempotent: a second call while a run
 * is in progress joins the existing one instead of starting a rival.
 */
export function startSetup(options: { background?: boolean } = {}): Promise<SetupState> {
	if (active) return active;
	active = execute().finally(() => {
		active = null;
	});
	if (options.background) {
		// The caller is not awaiting this; the state row is the source of truth.
		void active.catch((error) => {
			console.error('[setup] run failed:', error);
			void mutateState((s) => ({ ...s, running: false, current: null }));
		});
		return readState();
	}
	return active;
}

/** Re-run one step on demand, leaving the rest of the run untouched. */
export async function retryStep(id: StepId): Promise<SetupState> {
	const step = stepById(id);
	if (!step) return readState();
	await mutateState((s) => setStep(s, id, { status: 'pending', detail: 'Queued' }));
	const outcome = await runStep(step);
	return mutateState((s) => {
		const next = setStep(s, id, { status: outcome.status, detail: outcome.detail });
		if (outcome.k) next.k = outcome.k;
		return { ...next, running: false, current: null };
	});
}

/** Wipe stored progress so the wizard can be walked again from the top. */
export function resetSetup(): Promise<SetupState> {
	clearRetry();
	return mutateState(() => ({ ...emptyState() }));
}

export { STEP_ORDER };
