import { sql } from 'drizzle-orm';
import { db } from './db';

export type DuplicateCopy = {
	uri: string;
	name: string;
	album: string;
	artists: string[];
	clusterId: number | null;
	embedded: boolean;
	skipped: boolean;
	createdAt: string | null;
	/** Cosine similarity to the kept copy, when both have an embedding. */
	similarity: number | null;
};

export type DuplicateGroup = {
	key: string;
	name: string;
	album: string;
	artist: string;
	keeper: DuplicateCopy;
	victims: DuplicateCopy[];
	clusters: number[];
	/**
	 * Lowest similarity between the kept copy and any duplicate.
	 *
	 * A high value means the copies are the same recording and dropping one
	 * costs nothing. A low value means the same name and album point at
	 * genuinely different audio, which is a metadata collision rather than a
	 * duplicate, and the page treats those separately.
	 */
	similarity: number | null;
	/** True when the copies are different recordings, not duplicates. */
	mixedAudio: boolean;
};

export type DuplicateSummary = {
	groups: DuplicateGroup[];
	groupCount: number;
	duplicateCount: number;
	alreadySkipped: number;
	/** Copies that are not yet skipped, i.e. what an apply would act on. */
	pendingCount: number;
	/** Groups whose copies are different recordings, so should not auto-prune. */
	mixedAudioGroups: number;
};

type Row = {
	key: string;
	name: string;
	album: string;
	artist: string[];
	artist_key: string;
	uri: string;
	cluster_id: number | null;
	embedded: boolean;
	skipped: boolean;
	created_at: string | null;
	similarity: number | null;
};

/** Below this, two copies with the same name and album are different audio. */
export const MIXED_AUDIO_THRESHOLD = 0.9;
/** At or above this, the copies are the same recording. */
export const SAME_RECORDING_THRESHOLD = 0.99;

/**
 * The whole duplicate rule, in one place.
 *
 * A group is the same track from the same artist on the same album. The album
 * NAME is part of the key rather than the album uri on purpose: Music Assistant
 * holds duplicate album entries with adjacent ids for one real album, and
 * matching on the uri would never collapse them. Version variants ("Live at
 * Wembley", "Remastered") carry the marker in the track name, so they sort into
 * different groups and are never touched.
 *
 * The keeper is the copy that already has an embedding, so the expensive
 * OpenL3 work survives. Remaining ties break on created_at, then uri, which
 * makes the result stable across runs.
 */
const GROUP_SQL = sql`
	WITH grouped AS (
		SELECT
			lower(btrim(name)) AS gname,
			lower(artist[1]) AS gartist,
			lower(btrim(album)) AS galbum,
			uri, name, album, artist, cluster_id, skip, created_at,
			embedding, embedding_centered,
			embedding IS NOT NULL AS embedded
		FROM track
		WHERE cluster_id IS NOT NULL AND cluster_id >= 0
	),
	numbered AS (
		SELECT g.*,
			row_number() OVER (
				PARTITION BY gname, gartist, galbum
				ORDER BY embedded DESC, created_at ASC NULLS LAST, uri ASC
			) AS rn,
			first_value(embedding_centered) OVER (
				PARTITION BY gname, gartist, galbum
				ORDER BY embedded DESC, created_at ASC NULLS LAST, uri ASC
			) AS keeper_vec
		FROM grouped g
	)
	SELECT
		n.gname || '|' || n.gartist || '|' || n.galbum AS key,
		n.name, n.album, n.artist, n.gartist AS artist_key,
		n.uri, n.cluster_id, n.embedded, COALESCE(n.skip, FALSE) AS skipped, n.created_at,
		CASE WHEN n.keeper_vec IS NULL OR n.embedding_centered IS NULL THEN NULL
		     ELSE (1 - (n.embedding_centered <=> n.keeper_vec))::float
		END AS similarity
	FROM numbered n
	WHERE (n.gname, n.gartist, n.galbum) IN (
		SELECT gname, gartist, galbum FROM grouped
		GROUP BY 1,2,3 HAVING count(*) > 1
	)
	ORDER BY n.gname, n.gartist, n.galbum, n.rn
`;

export async function findDuplicates(limit = 500): Promise<DuplicateSummary> {
	let rows: Row[] = [];
	try {
		rows = (await db.execute(GROUP_SQL)) as unknown as Row[];
	} catch (error) {
		// Manage must stay usable if the scan cannot run, so report nothing
		// rather than taking the page down.
		console.error('[duplicates] scan failed:', error);
	}

	const byKey = new Map<string, Row[]>();
	for (const row of rows) {
		if (!byKey.has(row.key)) byKey.set(row.key, []);
		byKey.get(row.key)!.push(row);
	}

	const toCopy = (row: Row): DuplicateCopy => ({
		uri: row.uri,
		name: row.name,
		album: row.album,
		artists: row.artist,
		clusterId: row.cluster_id,
		embedded: row.embedded,
		skipped: row.skipped,
		createdAt: row.created_at,
		similarity: row.similarity === null ? null : Number(row.similarity)
	});

	const all: DuplicateGroup[] = [];
	for (const [key, list] of byKey) {
		if (list.length < 2) continue;
		const [keeper] = list;
		const copies = list.map(toCopy);
		const similarities = copies.map((c) => c.similarity).filter((s): s is number => s !== null);
		const similarity = similarities.length > 0 ? Math.min(...similarities) : null;
		all.push({
			key,
			name: keeper.name,
			album: keeper.album,
			artist: keeper.artist.join(', '),
			keeper: copies[0],
			victims: copies.slice(1),
			clusters: [...new Set(list.map((r) => r.cluster_id).filter((c) => c !== null))] as number[],
			similarity,
			mixedAudio: similarity !== null && similarity < MIXED_AUDIO_THRESHOLD
		});
	}

	// Biggest savings first, with the ambiguous ones last so they are not
	// pruned by someone who only reads the top of the list.
	all.sort(
		(a, b) =>
			Number(a.mixedAudio) - Number(b.mixedAudio) ||
			b.victims.length - a.victims.length ||
			a.name.localeCompare(b.name)
	);

	const shown = all.slice(0, limit);
	const allVictims = all.flatMap((g) => g.victims);

	return {
		groups: shown,
		groupCount: all.length,
		duplicateCount: allVictims.length,
		alreadySkipped: allVictims.filter((v) => v.skipped).length,
		pendingCount: allVictims.filter((v) => !v.skipped).length,
		mixedAudioGroups: all.filter((g) => g.mixedAudio).length
	};
}

/**
 * Uris of the duplicate copies within the given groups, using the same keeper
 * ordering as the scan. The scan and the mutation must agree, so both derive
 * from this one definition.
 */
function victimUris(keys: string[]) {
	return sql`
		WITH grouped AS (
			SELECT
				lower(btrim(name)) AS gname, lower(artist[1]) AS gartist,
				lower(btrim(album)) AS galbum, uri,
				embedding IS NOT NULL AS embedded, created_at
			FROM track WHERE cluster_id IS NOT NULL AND cluster_id >= 0
		),
		numbered AS (
			SELECT *, row_number() OVER (
				PARTITION BY gname, gartist, galbum
				ORDER BY embedded DESC, created_at ASC NULLS LAST, uri ASC
			) AS rn
			FROM grouped
		)
		SELECT uri FROM numbered
		WHERE rn > 1
			AND (gname || '|' || gartist || '|' || galbum) = ANY(${keys}::text[])
	`;
}

/**
 * How many of those victims are now in the requested skip state.
 *
 * The driver's row count for an UPDATE is unreliable, so the count is
 * re-derived from the table rather than trusted.
 */
async function countVictims(keys: string[], wantSkipped: boolean): Promise<number> {
	const rows = (await db.execute(sql`
		SELECT count(*)::int AS n FROM track
		WHERE uri IN (${victimUris(keys)}) AND COALESCE(skip, FALSE) = ${wantSkipped}
	`)) as unknown as Array<{ n: number }>;
	return Number(rows[0]?.n ?? 0);
}

/**
 * Fold every copy's embedding into the kept one, then skip the rest.
 *
 * A pruned duplicate usually carries an OpenL3 embedding that cost real GPU
 * time. Throwing it away is wasteful, so the keeper receives the mean of the
 * group's embeddings. For copies of one recording the mean is a mild
 * denoising; where the copies genuinely differ, the merged vector is the most
 * representative thing available rather than an arbitrary one.
 *
 * Writing `embedding` fires the centering trigger, so the derived
 * `embedding_centered` is recomputed from the merged raw vector and the two
 * cannot drift apart.
 */
export async function applyDuplicateSkip(keys: string[]): Promise<number> {
	if (keys.length === 0) return 0;

	await db.execute(sql`
		WITH numbered AS (
			SELECT n.*,
				row_number() OVER (
					PARTITION BY n.gname, n.gartist, n.galbum
					ORDER BY n.embedded DESC, n.created_at ASC NULLS LAST, n.uri ASC
				) AS rn
			FROM (
				SELECT lower(btrim(name)) AS gname, lower(artist[1]) AS gartist,
					lower(btrim(album)) AS galbum, uri, created_at,
					embedding, embedding IS NOT NULL AS embedded
				FROM track
				WHERE cluster_id IS NOT NULL AND cluster_id >= 0
			) n
			WHERE (n.gname || '|' || n.gartist || '|' || n.galbum) = ANY(${keys}::text[])
		),
		keepers AS (
			SELECT DISTINCT ON (gname || '|' || gartist || '|' || galbum)
				uri, gname || '|' || gartist || '|' || galbum AS key
			FROM numbered
			ORDER BY gname || '|' || gartist || '|' || galbum, rn
		),
		merged AS (
			SELECT n.gname || '|' || n.gartist || '|' || n.galbum AS key, avg(n.embedding) AS vec
			FROM numbered n
			WHERE n.embedding IS NOT NULL
			GROUP BY 1
			HAVING count(n.embedding) > 0
		)
		UPDATE track SET embedding = m.vec
		FROM keepers k JOIN merged m USING (key)
		WHERE track.uri = k.uri
			AND m.vec IS NOT NULL
			AND track.embedding IS DISTINCT FROM m.vec
	`);

	await db.execute(sql`
		UPDATE track SET skip = TRUE
		WHERE uri IN (${victimUris(keys)}) AND COALESCE(skip, FALSE) = FALSE
	`);
	return countVictims(keys, true);
}

/** Undo a previous cleanup for the given groups. Returns victims now active. */
export async function clearDuplicateSkip(keys: string[]): Promise<number> {
	if (keys.length === 0) return 0;
	await db.execute(sql`
		UPDATE track SET skip = FALSE
		WHERE uri IN (${victimUris(keys)}) AND COALESCE(skip, FALSE) = TRUE
	`);
	return countVictims(keys, false);
}
