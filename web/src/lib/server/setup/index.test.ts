import { describe, expect, mock, test } from 'bun:test';

let runs = 0;
let rejectRun: ((error: Error) => void) | undefined;
let resolveRun: (() => void) | undefined;
const steps = [
	{
		id: 'embed',
		probe: async () => ({ status: 'waiting', detail: 'Worker analysing tracks' }),
		run: async () => {
			runs++;
		}
	},
	{
		id: 'index',
		probe: async () => ({ status: 'pending', detail: 'No tracks indexed' }),
		run: async () => {
			runs++;
			await new Promise<void>((resolve, reject) => {
				resolveRun = resolve;
				rejectRun = reject;
			});
			return { status: 'done', detail: 'Indexed' };
		}
	}
];
mock.module('./steps', () => ({
	STEPS: steps,
	stepById: (id: string) => steps.find((step) => step.id === id)
}));
const { getSetupState, runSetupStep } = await import('./index');

describe('live setup checklist', () => {
	test('reads live readiness without starting work, including while the worker is pending', async () => {
		const state = await getSetupState();
		expect(state.steps.embed.status).toBe('waiting');
		expect(state.running).toBe(false);
		expect(state.complete).toBe(false);
		expect(runs).toBe(0);
	});

	test('serializes explicit actions and releases the guard after success or failure', async () => {
		expect(runSetupStep('index')).toBe(true);
		expect(runSetupStep('index')).toBe(false);
		expect(runSetupStep('embed')).toBe(false);
		expect((await getSetupState()).steps.index.status).toBe('running');
		resolveRun!();
		await Bun.sleep(0);
		expect((await getSetupState()).running).toBe(false);
		expect(runSetupStep('index')).toBe(true);
		await Bun.sleep(0);
		rejectRun!(new Error('Index unavailable'));
		await Bun.sleep(0);
		const failed = await getSetupState();
		expect(failed.running).toBe(false);
		expect(failed.steps.index).toMatchObject({
			status: 'failed',
			detail: 'Error: Index unavailable'
		});
		expect(runSetupStep('index')).toBe(true);
		await Bun.sleep(0);
		resolveRun!();
		await Bun.sleep(0);
	});
});
