import { sql } from 'drizzle-orm';
import { db } from './db';
import { finalizeEmbeddingSpace } from './finalize-embedding-space';

/**
 * Defaults for the first embedding space.
 *
 * These are what the worker has always used, so a library whose embeddings were
 * all produced before the settings were recorded is described accurately by them.
 */
export const DEFAULT_RECIPE = {
	model: 'openl3-512',
	hopSeconds: 0.1,
	maxSampleSeconds: 60,
	frontend: 'kapre'
} as const;

export type CenteredSpaceState = {
	/** Raw embeddings present. */
	rawEmbeddings: number;
	/** Rows with a derived centered vector. */
	centered: number;
	/** Rows stamped with the version that centred them. */
	versioned: number;
	/** Registered spaces. */
	spaces: number;
	/** The space a new write would be centred against, or null. */
	activeVersion: number | null;
	/** True when the failure is fixable: embeddings exist, no space to centre them. */
	needsSpace: boolean;
	/** True when a space exists but some rows were never centred. */
	needsBackfill: boolean;
	/** True when fewer than two embeddings exist, so no mean can be formed. */
	tooFewEmbeddings: boolean;
	provisionalNeedsCentering: boolean;
};

export async function getCenteredSpaceState(): Promise<CenteredSpaceState> {
	const [row] = (await db.execute(sql`
		SELECT
			(SELECT count(*)::int FROM track WHERE embedding IS NOT NULL) AS raw,
			(SELECT count(*)::int FROM track WHERE embedding_centered IS NOT NULL) AS centered,
			(SELECT count(*)::int FROM track WHERE embedding_space_version IS NOT NULL) AS versioned,
			(SELECT count(*)::int FROM embedding_space) AS spaces,
			(SELECT version FROM embedding_space ORDER BY version DESC LIMIT 1) AS active,
			EXISTS (
				SELECT 1 FROM embedding_space s WHERE s.track_count = 0 AND
				(SELECT count(*) FROM track t WHERE t.embedding_space_version = s.version
					AND t.embedding IS NOT NULL AND COALESCE(t.skip, FALSE) = FALSE) >= 2
			) AS provisional
	`)) as unknown as Array<{
		raw: number;
		centered: number;
		versioned: number;
		spaces: number;
		active: number | null;
		provisional: boolean;
	}>;

	const raw = Number(row?.raw ?? 0);
	const centered = Number(row?.centered ?? 0);
	const spaces = Number(row?.spaces ?? 0);

	return {
		rawEmbeddings: raw,
		centered,
		versioned: Number(row?.versioned ?? 0),
		spaces,
		activeVersion: row?.active === null || row?.active === undefined ? null : Number(row.active),
		// The failure this exists for: vectors were written, but there is no
		// mean to centre them against, so the trigger cannot derive anything.
		needsSpace: raw >= 2 && spaces === 0,
		needsBackfill: (raw > 0 && spaces > 0 && centered < raw) || Boolean(row?.provisional),
		provisionalNeedsCentering: Boolean(row?.provisional),
		tooFewEmbeddings: raw > 0 && raw < 2
	};
}

export type RepairResult = {
	ok: boolean;
	/** True when nothing needed doing. */
	alreadyHealthy: boolean;
	spaceCreated: boolean;
	spaceVersion: number | null;
	rowsCentered: number;
	skipped: string | null;
};

/**
 * Create the centered space and derive vectors for every raw embedding.
 *
 * This is the same work as `bun run db:ensure-centered`, exposed for the case
 * where an operator should not need a terminal. It is idempotent: the space is
 * only created when missing, and the backfill only touches rows whose centered
 * vector or version stamp is absent, so running it twice is a no-op.
 */
export async function repairCenteredSpace(
	options: { dryRun?: boolean } = {}
): Promise<RepairResult> {
	const before = await getCenteredSpaceState();

	if (before.tooFewEmbeddings) {
		return {
			ok: false,
			alreadyHealthy: false,
			spaceCreated: false,
			spaceVersion: before.activeVersion,
			rowsCentered: 0,
			skipped: `only ${before.rawEmbeddings} embedding(s) exist; a mean needs at least two`
		};
	}
	if (before.rawEmbeddings === 0) {
		return {
			ok: false,
			alreadyHealthy: true,
			spaceCreated: false,
			spaceVersion: before.activeVersion,
			rowsCentered: 0,
			skipped: 'no raw embeddings yet, nothing to centre'
		};
	}
	if (!before.needsSpace && !before.needsBackfill) {
		return {
			ok: true,
			alreadyHealthy: true,
			spaceCreated: false,
			spaceVersion: before.activeVersion,
			rowsCentered: 0,
			skipped: null
		};
	}

	if (options.dryRun) {
		return {
			ok: true,
			alreadyHealthy: false,
			spaceCreated: before.needsSpace,
			spaceVersion: before.activeVersion,
			rowsCentered: before.provisionalNeedsCentering ? before.rawEmbeddings : before.rawEmbeddings - before.centered,
			skipped: null
		};
	}

	if (before.provisionalNeedsCentering) {
		const rowsCentered = await db.transaction(async (tx) => {
			await tx.execute(sql`SELECT id FROM embedding_settings WHERE id = 1 FOR SHARE`);
			const provisional = await tx.execute(sql`
				SELECT version FROM embedding_space WHERE track_count = 0 ORDER BY version FOR UPDATE
			`);
			let centered = 0;
			for (const space of provisional) centered += await finalizeEmbeddingSpace(tx, Number(space.version));
			return centered;
		});
		return { ok: true, alreadyHealthy: false, spaceCreated: false,
			spaceVersion: before.activeVersion, rowsCentered, skipped: null };
	}

	// The mean and the derived columns are written together. The function and
	// trigger come from the same migration as the table, so if the table is
	// missing here the database predates the centered space entirely and this is
	// not the right repair.
	let spaceVersion = before.activeVersion;
	let spaceCreated = false;

	if (before.needsSpace) {
		const inserted = (await db.execute(sql`
			INSERT INTO embedding_space
				(version, model, mean_embedding, track_count, hop_seconds, max_sample_seconds, frontend)
			SELECT
				COALESCE((SELECT max(version) FROM embedding_space), 0) + 1,
				${DEFAULT_RECIPE.model},
				avg(embedding)::vector,
				count(*)::integer,
				${DEFAULT_RECIPE.hopSeconds},
				${DEFAULT_RECIPE.maxSampleSeconds},
				${DEFAULT_RECIPE.frontend}
			FROM track
			WHERE embedding IS NOT NULL AND COALESCE(skip, FALSE) = FALSE
			HAVING count(*) >= 2
			RETURNING version
		`)) as unknown as Array<{ version: number }>;

		spaceVersion = inserted[0]?.version ?? null;
		spaceCreated = Boolean(spaceVersion);
		if (spaceVersion === null) {
			return {
				ok: false,
				alreadyHealthy: false,
				spaceCreated: false,
				spaceVersion: null,
				rowsCentered: 0,
				skipped: 'could not compute a corpus mean from the available embeddings'
			};
		}
	}

	const target = spaceVersion ?? before.activeVersion;

	// When the space row had to be created, the mean it was rebuilt from is not
	// the mean any surviving vector was centred against - the old one is gone and
	// unrecoverable. So every embedded row is re-derived rather than trusting the
	// centered column, which would otherwise leave the library looking healthy
	// while its vectors disagree with the registered mean.
	const rederiveAll = spaceCreated;

	const updated = (await db.execute(sql`
		UPDATE track
		SET embedding_centered = center_openl3_embedding(
				embedding,
				(SELECT mean_embedding FROM embedding_space WHERE version = ${target})
			),
			embedding_space_version = ${target},
			updated_at = now()
		WHERE embedding IS NOT NULL
			AND EXISTS (SELECT 1 FROM embedding_space WHERE version = ${target})
			AND (
				${rederiveAll}
				OR embedding_centered IS NULL
				OR embedding_space_version IS DISTINCT FROM ${target}
			)
		RETURNING uri
	`)) as unknown as Array<{ uri: string }>;

	return {
		ok: true,
		alreadyHealthy: false,
		spaceCreated,
		spaceVersion: target,
		rowsCentered: updated.length,
		skipped: null
	};
}
