// Exercise the compiled server, including SvelteKit's unmatched-route fallback.
import { createServer } from 'node:net';

const socket = createServer();
await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
const port = (socket.address() as { port: number }).port;
await new Promise<void>((resolve) => socket.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;
const server = Bun.spawn([process.execPath, 'build/index.js'], {
	env: {
		...process.env,
		PORT: String(port), HOST: '127.0.0.1', ORIGIN: origin,
		MUSIC_HOST: '', MA_TOKEN: '',
		DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://unused:unused@127.0.0.1:1/unused'
	},
	stdout: 'ignore', stderr: 'ignore'
});

try {
	let ready = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			ready = (await fetch(`${origin}/api/health`)).ok;
		} catch { /* Wait for the HTTP listener. */ }
		if (ready) break;
		if (server.exitCode !== null) throw new Error(`Server exited with ${server.exitCode}`);
		await Bun.sleep(100);
	}
	if (!ready) throw new Error('Server did not become ready');
	for (const [path, status] of [
		['/api/unknown-smoke-test', 404],
		['/api/worker/unknown-smoke-test', 404],
		['/api/embedding-settings', 401]
	] as const) {
		const response = await fetch(`${origin}${path}`);
		if (response.status !== status || !response.headers.get('content-type')?.includes('application/json')) {
			throw new Error(`${path}: expected JSON ${status}, got ${response.status} ${response.headers.get('content-type')}`);
		}
		if (typeof (await response.json()).error !== 'string') throw new Error(`${path}: missing JSON error`);
	}
	console.log('Compiled-server API routing smoke test passed');
} finally {
	server.kill();
	await server.exited;
}
