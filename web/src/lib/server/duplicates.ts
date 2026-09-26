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
};

export type DuplicateGroup = {
	key: string;
	name: string;
	album: string;
	artist: string;
	keeper: DuplicateCopy;
	victims: DuplicateCopy[];
	clusters: number[];
};

export type DuplicateSummary = {
	groups: DuplicateGroup[];
	groupCount: number;
	duplicateCount: number;
	alreadySkipped: number;
	/** Copies that are not yet skipped, i.e. what an apply would act on. */
	pendingCount: number;
	losslyEmbeddedKept: boolean;
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
};

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
			embedding IS NOT NULL AS embedded
		FROM track
		WHERE cluster_id IS NOT NULL AND cluster_id >= 0
	),
	numbered AS (
		SELECT *,
			row_number() OVER (
				PARTITION BY gname, gartist, galbum
				ORDER BY embedded DESC, created_at ASC NULLS LAST, uri ASC
			) AS rn
		FROM grouped
	)
	SELECT
		gname || '|' || gartist || '|' || galbum AS key,
		name, album, artist, gartist AS artist_key,
		uri, cluster_id, embedded, COALESCE(skip, FALSE) AS skipped, created_at
	FROM numbered
	WHERE (gname, gartist, galbum) IN (
		SELECT gname, gartist, galbum FROM grouped
		GROUP BY 1,2,3 HAVING count(*) > 1
	)
	ORDER BY gname, gartist, galbum, rn
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
		createdAt: row.created_at
	});

	const all: DuplicateGroup[] = [];
	for (const [key, list] of byKey) {
		if (list.length < 2) continue;
		const [keeper, ...victims] = list;
		all.push({
			key,
			name: keeper.name,
			album: keeper.album,
			artist: keeper.artist.join(', '),
			keeper: toCopy(keeper),
			victims: victims.map(toCopy),
			clusters: [...new Set(list.map((r) => r.cluster_id).filter((c) => c !== null))] as number[]
		});
	}

	// Biggest savings first.
	all.sort((a, b) => b.victims.length - a.victims.length || a.name.localeCompare(b.name));

	const shown = all.slice(0, limit);
	const allVictims = all.flatMap((g) => g.victims);
	const embeddedVictims = allVictims.filter((v) => v.embedded).length;

	return {
		groups: shown,
		groupCount: all.length,
		duplicateCount: allVictims.length,
		alreadySkipped: allVictims.filter((v) => v.skipped).length,
		pendingCount: allVictims.filter((v) => !v.skipped).length,
		// If any victim carries an embedding the keeper did not, skipping it
		// discards work. The UI warns instead of silently doing it.
		losslyEmbeddedKept: embeddedVictims === 0
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

/** Skip the duplicate copies of the given groups. Returns victims now skipped. */
export async function applyDuplicateSkip(keys: string[]): Promise<number> {
	if (keys.length === 0) return 0;
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
