import { authenticateApiKey } from '$lib/server/api-keys';
import { matchesConfiguredToken, requestCredential } from '$lib/server/auth';

function authError(message: string): Response {
	return new Response(JSON.stringify({ error: message }), {
		status: 401,
		headers: {
			'Content-Type': 'application/json',
			'WWW-Authenticate': 'Bearer'
		}
	});
}

/** Authenticate a portable worker with either the bootstrap token or a scoped UI key. */
export async function workerAuthError(request: Request): Promise<Response | null> {
	if (!requestCredential(request)) return authError('worker authentication required');
	if (matchesConfiguredToken(request, 'WORKER_TOKEN')) return null;
	if (await authenticateApiKey(request, 'worker')) return null;
	return authError('invalid worker credentials');
}
