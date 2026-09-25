import { createHash, timingSafeEqual } from 'node:crypto';

function digest(value: string): Buffer {
	return createHash('sha256').update(value, 'utf8').digest();
}

/** Authenticate the portable Python worker without exposing the token in logs. */
export function workerAuthError(request: Request): Response | null {
	const expected = process.env.WORKER_TOKEN?.trim();
	if (!expected) {
		return Response.json(
			{ error: 'WORKER_TOKEN is not configured on the server' },
			{ status: 503 }
		);
	}

	const header = request.headers.get('Authorization') ?? '';
	const prefix = 'Bearer ';
	if (!header.startsWith(prefix)) {
		return new Response(JSON.stringify({ error: 'worker authentication required' }), {
			status: 401,
			headers: {
				'Content-Type': 'application/json',
				'WWW-Authenticate': 'Bearer'
			}
		});
	}

	const provided = header.slice(prefix.length);
	if (!timingSafeEqual(digest(provided), digest(expected))) {
		return new Response(JSON.stringify({ error: 'invalid worker credentials' }), {
			status: 401,
			headers: {
				'Content-Type': 'application/json',
				'WWW-Authenticate': 'Bearer'
			}
		});
	}

	return null;
}
