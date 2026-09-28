import { sql } from 'drizzle-orm';
import { db } from './db';

export type EmbeddingSpaceUsage = {
	version: number;
	model: string;
	hopSeconds: number | null;
	maxSampleSeconds: number | null;
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
	hopSeconds: number;
	maxSampleSeconds: number;
	frontend?: string;
	dryRun?: boolean;
}): Promise<{ version: number; created: boolean; trackCount: number | null; mixed: boolean }> {
	const model = input.model ?? 'openl3-512';
	const frontend = input.frontend ?? 'kapre';

	if (!Number.isFinite(input.hopSeconds) || input.hopSeconds <= 0) {
		throw new RangeError('hopSeconds must be a positive finite number');
	}
	if (!Number.isFinite(input.maxSampleSeconds) || input.maxSampleSeconds <= 0) {
		throw new RangeError('maxSampleSeconds must be a positive finite number');
	}
	if (input.hopSeconds > input.maxSampleSeconds) {
		throw new RangeError('hopSeconds must not exceed maxSampleSeconds');
	}

	const existing = (await db.execute(sql`
		SELECT version
		FROM embedding_space
		WHERE model = ${model}
			AND hop_seconds IS NOT DISTINCT FROM ${input.hopSeconds}
			AND max_sample_seconds IS NOT DISTINCT FROM ${input.maxSampleSeconds}
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
			mixed: usage.mixed
		};
	}

	if (input.dryRun) {
		return { version: -1, created: false, trackCount: null, mixed: false };
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
			${meanRow.n}, ${input.hopSeconds}, ${input.maxSampleSeconds}, ${frontend}
		FROM embedding_space
		RETURNING version
	`)) as unknown as Array<{ version: number }>;

	return {
		version: inserted[0].version,
		created: true,
		trackCount: Number(meanRow.n),
		mixed: false
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

/** One line per distinct recipe, for logs and CLI output. */
export function describeSpace(space: EmbeddingSpaceUsage): string {
	const hop = space.hopSeconds === null ? 'unknown' : `${space.hopSeconds}s`;
	const max = space.maxSampleSeconds === null ? 'unknown' : `${space.maxSampleSeconds}s`;
	return (
		`v${space.version} ${space.model} hop=${hop} max=${max}s` +
		` frontend=${space.frontend ?? 'kapre'} -> ${space.tracks.toLocaleString()} tracks` +
		` (${(space.share * 100).toFixed(1)}%)`
	);
}
