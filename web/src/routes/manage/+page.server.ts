import { getLastRuns, relativeTime, type JobSource, type LastRun } from '$lib/server/job-log';
import type { PageServerLoad } from './$types';
import { getEmbeddingSettings } from '$lib/server/embedding-settings';
import { db } from '$lib/server/db';
import { sql } from 'drizzle-orm';
import { getPlaybackPlayer } from '$lib/server/playback-settings';
import { listPlaybackPlayers } from '$lib/server/player';

export const load: PageServerLoad = async () => {
	const lastRuns = await getLastRuns().catch(() => ({}) as Record<string, LastRun | null>);
	const [library] = await db.execute(
		sql`SELECT EXISTS (SELECT 1 FROM track WHERE embedding IS NOT NULL) AS populated`
	);
	const musicAssistant = Boolean(process.env.MUSIC_HOST?.trim() && process.env.MA_TOKEN?.trim());
	const playbackPlayer = await getPlaybackPlayer();
	let playbackUnavailable = false;
	const playbackPlayers = musicAssistant
		? await listPlaybackPlayers().catch(() => {
				playbackUnavailable = true;
				return [];
			})
		: [];
	return {
		playbackPlayerId:
			playbackPlayers.find(
				(player) => player.id === playbackPlayer || player.name === playbackPlayer
			)?.id ?? playbackPlayer,
		playbackPlayers,
		playbackUnavailable,
		embeddingSettingsLocked: Boolean(library.populated),
		embeddingSettings: await getEmbeddingSettings(),
		// Every one of these jobs reads Music Assistant, so they cannot run
		// without it. Configured is not the same as reachable; a failed run
		// still reports itself in the job list.
		musicAssistant,
		lastRuns: Object.fromEntries(
			Object.entries(lastRuns).map(([job, run]) => [
				job,
				run
					? {
							ok: run.ok,
							detail: run.detail,
							source: run.source,
							when: relativeTime(run.finishedAt)
						}
					: null
			])
		) as Record<
			string,
			{ ok: boolean | null; detail: string | null; source: JobSource; when: string } | null
		>
	};
};
