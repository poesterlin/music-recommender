import { error, fail, type RequestEvent } from '@sveltejs/kit';
import type { z, ZodObject } from 'zod';

export function assert(condition: unknown, message: string): asserts condition;
export function assert(condition: unknown, code: number, message: string): asserts condition;
export function assert(condition: unknown, code: number | string, message?: string): asserts condition {
	if (!condition && typeof code === 'number') {
		error(code, message);
	}

	if (!condition) {
		throw new Error(message || 'Assertion failed');
	}
}

export type MaybePromise<T> = T | Promise<T>;

export function validateForm<T extends ZodObject<any>, Form extends z.infer<T>>(
	validator: T,
	action: (event: RequestEvent, form: Form) => MaybePromise<unknown>
) {
	return async function (event: RequestEvent) {
		const form = await event.request.formData();

		const data = Object.fromEntries(form);
		const result = validator.safeParse(data);

		if (!result.success) {
			return fail(400, { errors: result.error.errors, message: 'Invalid form data' });
		}

		return action(event, result.data as Form);
	};
}
