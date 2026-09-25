import type { AuthMethod, AuthState, AuthUser } from '$lib/server/auth';

declare global {
	namespace App {
		interface Locals {
			user: AuthUser | null;
			session: AuthState['session'];
			method: AuthMethod | null;
		}
	}
}

export {};
