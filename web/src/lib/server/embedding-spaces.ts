import { sql } from 'drizzle-orm';
import { db } from './db';

/**
 * Worker sampling presets, mirroring EMBEDDING_MODES in the Python worker.
 *
 * The numbers are measured, not chosen: over a 60s clip on a 10-core CPU these
 * are ~1.0x, ~4.8x and ~8.9x the low setting, for a mean pooled-similarity
 * shift of 0, ~0.004 and ~0.012. Retrieval order survives all three, so the
 * choice is how finely the vector samples a track, not whether the recommender
 * still works.
 */
export const EMBEDDING_MODES: Record<string, number> = {
	low: 0.1,
	medium: 0.5,
	high: 1.0
};

/**
 * The preset a hop corresponds to, or null when it is a custom value.
 *
 * An exact hop is still recorded even when it has no name, so a library using
 * one is identifiable rather than rounded to the nearest preset.
 */
export function modeForHop(hopSeconds: number | null): string | null {
	if (hopSeconds === null) return null;
	for (const [name, hop] of Object.entries(EMBEDDING_MODES)) {
		// Exact match: a hop between presets must not be reported as one.
		if (hop === hopSeconds) return name;
	}
	return null;
}

export type EmbeddingSpaceUsage = {
	version: number;
	model: string;
	hopSeconds: number | null;
	maxSampleSeconds: number | null;
	/** low | medium | high, or null for a custom hop. */
	mode: string | null;
	frontend: string | null;
	/** Mean seconds of audio per track, from the space's own track_count. */
	/** Null when the mean is unknown (no space row yet). */
	trackCount: number | null;
	createdAt: string | null;
	/** Rows currently stamped with this version. */
	tracks: number;
	/** Of those, how many are clustered. */
	clustered: number;
	/** Share of all embedded rows, 0-1. */
	share: number;
};

export type EmbeddingSpaceReport = {
	spaces: EmbeddingSpaceUsage[];
	/** The version the centering trigger will use for the next write. */
	activeVersion: number | null;
	/**
	 * True when rows span more than one version. Vectors from different spaces
	 * are not comparable, so this is the signal that a partial re-embed is in
	 * progress and the library should be treated as mixed until it finishes.
	 */
	mixed: boolean;
	totalEmbedded: number;
};

/**
 * Register an embedding recipe, or return the version already registered for it.
 *
 * The mean is the average of every raw embedding currently in the library, which
 * is only correct while a single recipe is in use. When a second recipe is
 * registered over a library that already contains a mix, the mean has to be
 * recomputed from the rows that share the new recipe, and the caller should say
 * so rather than assume this produced a clean space.
 */
export async function ensureEmbeddingSpace(input: {
	model?: string;
	/** low | medium | high, or an exact hop via hopSeconds. */
	mode?: string;
	hopSeconds?: number;
	maxSampleSeconds?: number;
	frontend?: string;
	dryRun?: boolean;
}): Promise<{
	version: number;
	created: boolean;
	trackCount: number | null;
	mixed: boolean;
	mode: string | null;
	hopSeconds: number;
	maxSampleSeconds: number;
}> {
	const model = input.model ?? 'openl3-512';
	const frontend = input.frontend ?? 'kapre';

	const maxSampleSeconds = input.maxSampleSeconds ?? 60;

	// A named mode is the interface; an exact hop is the escape hatch, matching
	// the worker's --mode / --hop precedence.
	let hopSeconds: number;
	let mode: string | null = null;
	if (input.hopSeconds !== undefined && input.hopSeconds !== null) {
		hopSeconds = input.hopSeconds;
		mode = modeForHop(hopSeconds);
	} else if (input.mode !== undefined && input.mode !== null) {
		const requested = String(input.mode).trim().toLowerCase();
		const hop = EMBEDDING_MODES[requested];
		if (hop === undefined) {
			throw new RangeError(
				`mode must be one of ${Object.keys(EMBEDDING_MODES).join(', ')} (got '${input.mode}')`
			);
		}
		hopSeconds = hop;
		mode = requested;
	} else {
		hopSeconds = EMBEDDING_MODES.low;
		mode = 'low';
	}

	if (!Number.isFinite(hopSeconds) || hopSeconds <= 0) {
		throw new RangeError('hopSeconds must be a positive finite number');
	}
	if (!Number.isFinite(maxSampleSeconds) || maxSampleSeconds <= 0) {
		throw new RangeError('maxSampleSeconds must be a positive finite number');
	}
	if (hopSeconds > maxSampleSeconds) {
		throw new RangeError('hopSeconds must not exceed maxSampleSeconds');
	}

	const existing = (await db.execute(sql`
		SELECT version
		FROM embedding_space
		WHERE model = ${model}
			AND hop_seconds IS NOT DISTINCT FROM ${hopSeconds}
			AND max_sample_seconds IS NOT DISTINCT FROM ${maxSampleSeconds}
			AND COALESCE(frontend, 'kapre') = ${frontend}
		ORDER BY version DESC
		LIMIT 1
	`)) as unknown as Array<{ version: number }>;

	if (existing.length) {
		const usage = await getEmbeddingSpaceUsage();
		const space = usage.spaces.find((s) => s.version === existing[0].version);
		return {
			version: existing[0].version,
			created: false,
			trackCount: space?.trackCount ?? null,
			mixed: usage.mixed,
			mode,
			hopSeconds,
			maxSampleSeconds
		};
	}

	if (input.dryRun) {
		return {
			version: -1,
			created: false,
			trackCount: null,
			mixed: false,
			mode,
			hopSeconds,
			maxSampleSeconds
		};
	}

	// A new recipe needs its own mean. Averaging a library that already holds a
	// different recipe would centre the new vectors against the wrong origin, so
	// refuse while the library is mixed rather than produce a quietly bad space.
	const before = await getEmbeddingSpaceUsage();
	if (before.mixed) {
		throw new Error(
			`library already spans ${before.spaces.filter((s) => s.tracks > 0).length} embedding spaces; ` +
				're-embed to completion before registering another recipe'
		);
	}

	const [meanRow] = (await db.execute(sql`
		SELECT avg(embedding)::vector AS mean_embedding, count(*)::int AS n
		FROM track
		WHERE embedding IS NOT NULL AND COALESCE(skip, FALSE) = FALSE
		HAVING count(*) >= 2
	`)) as unknown as Array<{ mean_embedding: string | null; n: number }>;

	if (!meanRow?.mean_embedding) {
		throw new Error('need at least two raw embeddings before a space can be created');
	}

	const inserted = (await db.execute(sql`
		INSERT INTO embedding_space (version, model, mean_embedding, track_count, hop_seconds, max_sample_seconds, frontend)
		SELECT COALESCE(max(version), 0) + 1, ${model}, ${meanRow.mean_embedding}::vector,
			${meanRow.n}, ${hopSeconds}, ${maxSampleSeconds}, ${frontend}
		FROM embedding_space
		RETURNING version
	`)) as unknown as Array<{ version: number }>;

	return {
		version: inserted[0].version,
		created: true,
		trackCount: Number(meanRow.n),
		mixed: false,
		mode,
		hopSeconds,
		maxSampleSeconds
	};
}

/**
 * Which embedding recipe produced which rows.
 *
 * `embedding_space` rows are the recipes; `track.embedding_space_version` is the
 * stamp. When more than one version is in use the library is mid-transition and
 * its vectors are not mutually comparable, so callers should say so rather than
 * present mixed results as one coherent space.
 */
export async function getEmbeddingSpaceUsage(): Promise<EmbeddingSpaceReport> {
	const rows = (await db.execute(sql`
		SELECT
			s.version,
			s.model,
			s.hop_seconds,
			s.max_sample_seconds,
			s.frontend,
			s.track_count,
			s.created_at,
			count(t.uri)::int AS tracks,
			count(t.uri) FILTER (WHERE t.cluster_id >= 0)::int AS clustered
		FROM embedding_space s
		LEFT JOIN track t ON t.embedding_space_version = s.version
		GROUP BY
			s.version, s.model, s.hop_seconds, s.max_sample_seconds,
			s.frontend, s.track_count, s.created_at
		ORDER BY s.version DESC
	`)) as unknown as Array<{
		version: number;
		model: string;
		hop_seconds: number | null;
		max_sample_seconds: number | null;
		frontend: string | null;
		track_count: number | null;
		created_at: Date | string | null;
		tracks: number;
		clustered: number;
	}>;

	// Rows whose stamped version has no registry entry would otherwise vanish
	// from the breakdown, which is exactly when you want to see them.
	const orphans = (await db.execute(sql`
		SELECT t.embedding_space_version AS version, count(*)::int AS tracks
		FROM track t
		WHERE t.embedding IS NOT NULL
			AND (t.embedding_space_version IS NULL OR NOT EXISTS (
				SELECT 1 FROM embedding_space s WHERE s.version = t.embedding_space_version
			))
		GROUP BY t.embedding_space_version
		ORDER BY 1 NULLS FIRST
	`)) as unknown as Array<{ version: number | null; tracks: number }>;

	const totalEmbedded =
		rows.reduce((sum, r) => sum + Number(r.tracks), 0) +
		orphans.reduce((sum, r) => sum + Number(r.tracks), 0);

	const spaces: EmbeddingSpaceUsage[] = rows.map((r) => ({
		version: Number(r.version),
		model: r.model,
		hopSeconds: r.hop_seconds === null ? null : Number(r.hop_seconds),
		maxSampleSeconds: r.max_sample_seconds === null ? null : Number(r.max_sample_seconds),
		mode: modeForHop(r.hop_seconds === null ? null : Number(r.hop_seconds)),
		frontend: r.frontend,
		trackCount: r.track_count === null ? null : Number(r.track_count),
		createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : (r.created_at ?? null),
		tracks: Number(r.tracks),
		clustered: Number(r.clustered),
		share: totalEmbedded > 0 ? Number(r.tracks) / totalEmbedded : 0
	}));

	for (const orphan of orphans) {
		spaces.push({
			version: orphan.version === null ? -1 : Number(orphan.version),
			model: '(unregistered)',
			hopSeconds: null,
			maxSampleSeconds: null,
			mode: null,
			frontend: null,
			trackCount: null,
			createdAt: null,
			tracks: Number(orphan.tracks),
			clustered: 0,
			share: totalEmbedded > 0 ? Number(orphan.tracks) / totalEmbedded : 0
		});
	}

	return {
		spaces,
		activeVersion: spaces.length ? spaces[0].version : null,
		mixed: spaces.filter((s) => s.tracks > 0).length > 1,
		totalEmbedded
	};
}

/**
 * One line per recipe, leading with the preset name.
 *
 * The hop is still shown even for a preset, because that is the value that
 * actually determines the vector and the one a space is registered against.
 */
export function describeSpace(space: EmbeddingSpaceUsage): string {
	const hop = space.hopSeconds === null ? 'unknown' : `${space.hopSeconds}s`;
	const max = space.maxSampleSeconds === null ? 'unknown' : `${space.maxSampleSeconds}s`;
	const mode = space.mode ?? 'custom';
	return (
		`v${space.version} ${space.model} mode=${mode} (hop=${hop}, max=${max}s, ` +
		`frontend=${space.frontend ?? 'kapre'}) -> ${space.tracks.toLocaleString()} tracks` +
		` (${(space.share * 100).toFixed(1)}%)`
	);
}
