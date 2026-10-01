import postgres from 'postgres';

const db = postgres(process.env.DATABASE_URL!);
try {
	await db.unsafe(await Bun.file(new URL('../drizzle/0019_playback_settings.sql', import.meta.url)).text());
	console.log('Playback settings schema ready.');
} finally {
	await db.end();
}
