import { sql } from 'drizzle-orm';
import { db } from './db';

/**
 * The one embedding recipe the server and every worker agree on.
 *
 * This used to be a constant in two places -- `DEFAULT_HOP_SECONDS` in the
 * Python core and `DEFAULT_RECIPE` here -- while uploads were resolved by exact
 * match with no fallback. That combination is safe (a mismatched vector is
 * rejected rather than silently mixed) and extremely annoying to operate: move a
 * default in one place and every upload starts returning 409 until somebody
 * notices and registers the new recipe by hand.
 *
 * So the recipe is stored state. The server reads it when it creates a space,
 * and hands it to the worker, which therefore cannot declare a recipe the server
 * has not registered.
 */

export const EMBEDDING_MODEL = 'openl3-512';

/**
 * Preset name -> window hop, mirroring `EMBEDDING_MODES` in
 * `embeddings/generate-local-embeddings.py`.
 *
 * Duplicated deliberately and kept small on purpose: in API mode the worker does
 * not use this table at all, it uses whatever the server sends. The copy exists
 * only so the UI can label a value and so the two sides agree on what "medium"
 * means when someone reads a log. If they ever drift, the stored hop is still
 * authoritative and nothing breaks -- only the label is wrong.
 */
export const EMBEDDING_MODES: Record<string, number> = {
	low: 0.1,
	medium: 0.5,
	high: 1.0
};

/** The preset name that produced this hop, or null if it is hand-tuned. */
export function modeForHop(hopSeconds: number | null): string | null {
	if (hopSeconds === null) return null;
	for (const [name, hop] of Object.entries(EMBEDDING_MODES)) {
		if (hop === hopSeconds) return name;
	}
	return null;
}

export type EmbeddingSettings = {
	mode: string;
	hopSeconds: number;
	maxSampleSeconds: number;
	frontend: string;
	updatedAt: string | null;
	/** True when the row is absent and these are the compiled-in fallbacks. */
	usingDefaults: boolean;
};

export async function getEmbeddingSettings(): Promise<EmbeddingSettings> {
	const rows = (await db.execute(sql`
		SELECT mode, hop_seconds, max_sample_seconds, frontend, updated_at
		FROM embedding_settings
		WHERE id = 1
	`)) as unknown as Array<{
		mode: string;
		hop_seconds: number;
		max_sample_seconds: number;
		frontend: string;
		updated_at: Date | string | null;
	}>;
	const row = rows[0];
	if (!row) throw new Error('Embedding settings are missing; apply database migrations.');
	return {
		mode: row.mode,
		hopSeconds: Number(row.hop_seconds),
		maxSampleSeconds: Number(row.max_sample_seconds),
		frontend: row.frontend,
		updatedAt:
			row.updated_at instanceof Date
				? row.updated_at.toISOString()
				: row.updated_at ?? null,
		usingDefaults: false
	};
}

export class EmbeddingSettingsError extends Error {}

/**
 * Store a new recipe.
 *
 * Writing this does not create a space and does not touch existing embeddings.
 * It records the intent so that the next space creation and every worker use
 * these numbers. Registering the recipe as an actual space is still an explicit
 * step, because doing it implicitly would write a corpus mean to every embedded
 * track.
 */
export async function setEmbeddingSettings(input: {
	mode?: string;
	hopSeconds?: number;
	maxSampleSeconds?: number;
	frontend?: string;
}): Promise<EmbeddingSettings> {
	const current = await getEmbeddingSettings();

	const mode = input.mode ?? current.mode;
	const frontend = input.frontend ?? current.frontend;

	let hopSeconds = input.hopSeconds ?? current.hopSeconds;
	const maxSampleSeconds = input.maxSampleSeconds ?? current.maxSampleSeconds;

	// A mode with no explicit hop means the preset's hop. `low` stays available
	// as a way to ask for the finer sampling back without restating the number.
	if (input.mode !== undefined && input.hopSeconds === undefined) {
		if (!(mode in EMBEDDING_MODES)) {
			throw new EmbeddingSettingsError(
				`unknown mode ${JSON.stringify(mode)}; expected one of ${Object.keys(EMBEDDING_MODES).sort().join(', ')}`
			);
		}
		hopSeconds = EMBEDDING_MODES[mode];
	}

	for (const [label, value] of [
		['hopSeconds', hopSeconds],
		['maxSampleSeconds', maxSampleSeconds]
	] as const) {
		if (!Number.isFinite(value) || value <= 0) {
			throw new EmbeddingSettingsError(`${label} must be a positive finite number`);
		}
	}
	if (hopSeconds > maxSampleSeconds) {
		throw new EmbeddingSettingsError(
			`hopSeconds (${hopSeconds}) cannot exceed maxSampleSeconds (${maxSampleSeconds}); a hop larger than the sample yields no windows`
		);
	}
	if (typeof frontend !== 'string' || frontend.length === 0 || frontend.length > 64) {
		throw new EmbeddingSettingsError('frontend must be a non-empty string of at most 64 characters');
	}

	const rows = (await db.execute(sql`
		INSERT INTO embedding_settings (id, mode, hop_seconds, max_sample_seconds, frontend, updated_at)
		VALUES (1, ${mode}, ${hopSeconds}, ${maxSampleSeconds}, ${frontend}, now())
		ON CONFLICT (id) DO UPDATE SET
			mode = EXCLUDED.mode,
			hop_seconds = EXCLUDED.hop_seconds,
			max_sample_seconds = EXCLUDED.max_sample_seconds,
			frontend = EXCLUDED.frontend,
			updated_at = now()
		RETURNING mode, hop_seconds, max_sample_seconds, frontend, updated_at
	`)) as unknown as Array<{
		mode: string;
		hop_seconds: number;
		max_sample_seconds: number;
		frontend: string;
		updated_at: Date | string;
	}>;

	const saved = rows[0];
	return {
		mode: saved.mode,
		hopSeconds: Number(saved.hop_seconds),
		maxSampleSeconds: Number(saved.max_sample_seconds),
		frontend: saved.frontend,
		updatedAt: saved.updated_at instanceof Date ? saved.updated_at.toISOString() : saved.updated_at,
		usingDefaults: false
	};
}

/** The recipe handed to a worker: the stored settings, no defaults mixed in. */
export async function getWorkerRecipe(): Promise<{
	model: string;
	hopSeconds: number;
	maxSampleSeconds: number;
	frontend: string;
}> {
	const settings = await getEmbeddingSettings();
	return {
		model: EMBEDDING_MODEL,
		hopSeconds: settings.hopSeconds,
		maxSampleSeconds: settings.maxSampleSeconds,
		frontend: settings.frontend
	};
}
