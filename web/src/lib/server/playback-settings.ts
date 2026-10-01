import { sql } from 'drizzle-orm';
import { db } from './db';

export async function getPlaybackPlayer(): Promise<string | null> {
	const rows = await db.execute(sql`SELECT player_id FROM playback_settings WHERE id = 1`);
	return rows.length
		? (rows[0].player_id as string | null)
		: process.env.MA_PLAYER_NAME?.trim() || null;
}

export async function setPlaybackPlayer(playerId: string | null): Promise<void> {
	await db.execute(sql`
		INSERT INTO playback_settings (id, player_id) VALUES (1, ${playerId})
		ON CONFLICT (id) DO UPDATE SET player_id = EXCLUDED.player_id, updated_at = now()
	`);
}
