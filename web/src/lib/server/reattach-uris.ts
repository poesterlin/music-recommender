/**
 * Reattach cluster assignments to the library URIs Music Assistant recognises.
 *
 * The Plex id shift left two rows for most tracks: one under the URI Music
 * Assistant issues now, and one under the id it used to. The embeddings and
 * `cluster_id` values were computed against the old set, so they sit on the stale
 * rows — which means the clusters are attached to rows no external system will
 * ever resolve. Measured on this database: 18,093 stale rows carry a cluster_id,
 * and only 15,404 live URIs have one.
 *
 * Every stale row here resolves by name+album+artist to a URI that *already has
 * a row*, so this is never a rename. It is always a merge: fold the copies'
 * embeddings into the live row, give the live row the cluster its dead twin was
 * assigned, then drop the rest.
 *
 * The keeper therefore has to prefer a live URI. The interactive duplicate scan
 * in `$lib/server/duplicates` cannot do that, because it picks a keeper in
 * static SQL with no knowledge of Music Assistant, so this is deliberately a
 * separate, explicit operation rather than a change to that scan.
 */

import { sql } from 'drizzle-orm';
import { withMa } from './ma-client';
import { db } from './db';

/** The same group key `$lib/server/duplicates` uses. */
const GROUP_KEY = sql`lower(btrim(name)) || '|' || lower(artist[1]) || '|' || lower(btrim(album))`;

export type ReattachPlan = {
	/** MA library URIs that exist right now. */
	liveUris: number;
	rows: number;
	groups: number;
	duplicateGroups: number;
	/** Groups whose keeper would change under the live-first rule. */
	keepersChanged: number;
	/** Stale rows folded into a keeper. */
	merged: number;
	/** Stale rows deleted. */
	deleted: number;
	/** Groups where no copy has a live URI; every row goes. */
	orphanGroups: number;
	orphanRows: number;
	/** Copies that carry an embedding or a cluster, which is what is at stake. */
	embeddingsAtStake: number;
	clustersAtStake: number;
	clustersAlreadyOnKeeper: number;
	/** Live URIs carrying a cluster_id, before and after. */
	clusteredLiveBefore: number;
	clusteredLiveAfter: number;
	/**
	 * What coverage would be if the merge only folded embeddings and left
	 * `cluster_id` alone. Kept because it is not obviously worse: the keeper
	 * changes for most groups, so a live row can *lose* a cluster it already
	 * had when its dead twin was the one being kept.
	 */
	clusteredLiveAfterWithoutClusterInheritance: number;
};

type Row = {
	uri: string;
	key: string;
	clusterId: number | null;
	embedded: boolean;
	createdAt: string | null;
};

type Snapshot = {
	live: Set<string>;
	rows: Row[];
	clusteredLiveBefore: number;
};

/** MA's current library URIs. Cached: one fetch drives the whole operation. */
export async function fetchLiveUris(): Promise<Set<string>> {
	return withMa(async (call) => {
		const uris = new Set<string>();
		for (let offset = 0; ; offset += 2000) {
			const page = await call('music/tracks/library_items', {
				limit: 2000,
				offset,
				order_by: 'sort_name'
			});
			if (!Array.isArray(page) || page.length === 0) break;
			for (const track of page) {
				const uri = String(track?.uri ?? '');
				if (uri) uris.add(uri);
			}
			if (page.length < 2000) break;
		}
		return uris;
	});
}

async function snapshot(live: Set<string>): Promise<Snapshot> {
	const rows = (await db.execute(sql`
		SELECT uri, ${GROUP_KEY} AS key, cluster_id, created_at,
		       embedding IS NOT NULL AS embedded
		FROM track
	`)) as unknown as Array<{
		uri: string;
		key: string;
		cluster_id: number | null;
		created_at: string | null;
		embedded: boolean;
	}>;

	let clusteredLiveBefore = 0;
	for (const r of rows) {
		if (live.has(r.uri) && r.cluster_id !== null && r.cluster_id >= 0) clusteredLiveBefore += 1;
	}
	return {
		live,
		rows: rows.map((r) => ({
			uri: r.uri,
			key: r.key,
			clusterId: r.cluster_id,
			embedded: Boolean(r.embedded),
			createdAt: r.created_at
		})),
		clusteredLiveBefore
	};
}

type Group = {
	key: string;
	live: Row[];
	stale: Row[];
	keeper: Row;
	oldKeeper: Row;
};

/**
 * Live URI first, then the copy that carries an embedding, then oldest.
 *
 * The old rule was embedding-first, which here always picked a dead row.
 */
function keeperOf(live: Set<string>, rows: Row[]) {
	return [...rows].sort(
		(a, b) =>
			(live.has(b.uri) ? 1 : 0) - (live.has(a.uri) ? 1 : 0) ||
			(b.embedded ? 1 : 0) - (a.embedded ? 1 : 0) ||
			String(a.createdAt ?? '9999').localeCompare(String(b.createdAt ?? '9999')) ||
			a.uri.localeCompare(b.uri)
	)[0]!;
}

function group(snap: Snapshot): Group[] {
	const byKey = new Map<string, Row[]>();
	for (const r of snap.rows) {
		const bucket = byKey.get(r.key);
		if (bucket) bucket.push(r);
		else byKey.set(r.key, [r]);
	}

	const out: Group[] = [];
	for (const [key, rows] of byKey) {
		const liveRows = rows.filter((r) => snap.live.has(r.uri));
		const stale = rows.filter((r) => !snap.live.has(r.uri));
		out.push({
			key,
			live: liveRows,
			stale,
			keeper: keeperOf(snap.live, rows),
			oldKeeper: keeperOf(new Set(), rows)
		});
	}
	return out;
}

/** Work out exactly what would change. Reads only. */
export async function planReattach(): Promise<ReattachPlan> {
	const live = await fetchLiveUris();
	const snap = await snapshot(live);
	const groups = group(snap);
	const dupes = groups.filter((g) => g.live.length + g.stale.length > 1);
	const orphans = dupes.filter((g) => g.live.length === 0);
	const singles = groups.filter((g) => g.live.length + g.stale.length === 1);

	let merged = 0;
	let embeddingsAtStake = 0;
	let clustersAtStake = 0;
	let clustersAlreadyOnKeeper = 0;
	// A single row that is live keeps whatever it already has, so it is the
	// baseline the merge result is added to rather than something it replaces.
	const singlesWithCluster = singles.filter(
		(g) => g.live[0] && g.live[0].clusterId !== null && g.live[0].clusterId >= 0
	).length;
	let clusteredLiveAfter = singlesWithCluster;
	// Without inheriting a cluster, a live row that has none stays unclustered
	// even though its dead twin was assigned to one.
	let clusteredLiveAfterWithoutClusterInheritance = singlesWithCluster;

	for (const g of dupes) {
		if (g.live.length === 0) {
			// Every copy is stale; there is nowhere to fold anything.
			for (const r of [...g.live, ...g.stale]) {
				if (r.embedded) embeddingsAtStake += 1;
				if (r.clusterId !== null && r.clusterId >= 0) clustersAtStake += 1;
			}
			continue;
		}
		merged += g.stale.length;
		if (g.keeper.clusterId !== null && g.keeper.clusterId >= 0) {
			clustersAlreadyOnKeeper += 1;
			clusteredLiveAfter += 1;
			clusteredLiveAfterWithoutClusterInheritance += 1;
		} else if (g.stale.some((r) => r.clusterId !== null && r.clusterId >= 0)) {
			// Inherited from a dead twin, so this is the gain the operation buys.
			clusteredLiveAfter += 1;
		}
		for (const r of g.stale) {
			if (r.embedded) embeddingsAtStake += 1;
			if (r.clusterId !== null && r.clusterId >= 0) clustersAtStake += 1;
		}
	}

	return {
		liveUris: live.size,
		rows: snap.rows.length,
		groups: groups.length,
		duplicateGroups: dupes.length,
		keepersChanged: dupes.filter((g) => g.keeper.uri !== g.oldKeeper.uri).length,
		merged,
		deleted: merged,
		orphanGroups: orphans.length,
		orphanRows: orphans.reduce((a, g) => a + g.live.length + g.stale.length, 0),
		embeddingsAtStake,
		clustersAtStake,
		clustersAlreadyOnKeeper,
		clusteredLiveBefore: snap.clusteredLiveBefore,
		clusteredLiveAfter,
		clusteredLiveAfterWithoutClusterInheritance:
			clusteredLiveAfterWithoutClusterInheritance
	};
}

/**
 * Carry out the merge. Reads the plan, folds, then deletes — in that order, in
 * one transaction, so a failure part-way leaves the table as it was rather than
 * with embeddings dropped and no clusters to show for it.
 */
export async function applyReattach(): Promise<ReattachPlan> {
	const live = await fetchLiveUris();
	// Read the plan before opening the transaction: it re-reads Music Assistant,
	// and holding a database transaction open across a network call is needless.
	const plan = await planReattach();

	// The temp tables are declared ON COMMIT DROP and the fold/inherit/delete
	// statements depend on each other, so this has to be one transaction.
	// Without it the first statement would commit and take the plan table with
	// it, and the delete would run against nothing.
	return db.transaction(async (tx) => {
	await tx.execute(sql`CREATE TEMP TABLE reattach_live (uri text PRIMARY KEY) ON COMMIT DROP`);
	for (const batch of chunk([...live], 5000)) {
		const values = sql.join(batch.map((u) => sql`(${u}::text)`), sql`, `);
		await tx.execute(sql`INSERT INTO reattach_live (uri) VALUES ${values} ON CONFLICT DO NOTHING`);
	}

	// One row per copy, classified. Computed once so the fold, the inheritance
	// and the delete all agree on what is what.
	await tx.execute(sql`
		CREATE TEMP TABLE reattach_plan ON COMMIT DROP AS
		WITH keyed AS (
			SELECT uri, name, artist, album, cluster_id, created_at,
			       embedding IS NOT NULL AS embedded,
			       lower(btrim(name)) || '|' || lower(artist[1]) || '|' || lower(btrim(album)) AS gkey,
			       EXISTS (SELECT 1 FROM reattach_live l WHERE l.uri = track.uri) AS is_live
			FROM track
		), ranked AS (
			SELECT k.*, row_number() OVER (
				PARTITION BY gkey
				ORDER BY is_live DESC, embedded DESC, created_at ASC NULLS LAST, uri ASC
			) AS rn
			FROM keyed k
		)
		SELECT uri, gkey, cluster_id, embedded, rn = 1 AS is_keeper
		FROM ranked
		WHERE gkey IN (SELECT gkey FROM keyed GROUP BY 1 HAVING count(*) > 1)
	`);

	// 1. Fold every copy's embedding into the keeper. Writing `embedding` fires
	//    the centering trigger, so `embedding_centered` is recomputed rather
	//    than left to drift.
	await tx.execute(sql`
		UPDATE track t
		SET embedding = m.vec
		FROM reattach_plan p
		CROSS JOIN LATERAL (
			SELECT avg(s.embedding) AS vec FROM track s, reattach_plan p2
			WHERE p2.gkey = p.gkey AND s.uri = p2.uri AND s.embedding IS NOT NULL
		) m
		WHERE t.uri = p.uri AND p.is_keeper AND m.vec IS NOT NULL
			AND t.embedding IS DISTINCT FROM m.vec
	`);

	// 2. Give the keeper the cluster its dead twin was assigned, by majority.
	//    A cluster is a property of the audio, not of the URI it was filed
	//    under, so the assignment survives the move.
	await tx.execute(sql`
		UPDATE track t
		SET cluster_id = src.cluster_id
		FROM reattach_plan p
		CROSS JOIN LATERAL (
			SELECT q.cluster_id, count(*) AS votes
			FROM reattach_plan q
			WHERE q.gkey = p.gkey AND q.cluster_id IS NOT NULL AND q.cluster_id >= 0
			GROUP BY q.cluster_id
			ORDER BY votes DESC, q.cluster_id ASC
			LIMIT 1
		) src
		WHERE t.uri = p.uri AND p.is_keeper
			AND (t.cluster_id IS NULL OR t.cluster_id < 0)
			AND src.cluster_id IS NOT NULL
	`);

	// 3. Only now drop the copies. Orphans — groups where no copy has a live
	//    URI — have no keeper and are removed outright.
	await tx.execute(sql`DELETE FROM track WHERE uri IN (SELECT uri FROM reattach_plan WHERE NOT is_keeper)`);

	await tx.execute(sql`
		DELETE FROM track t
		WHERE NOT EXISTS (SELECT 1 FROM reattach_live l WHERE l.uri = t.uri)
			AND lower(btrim(t.name)) || '|' || lower(t.artist[1]) || '|' || lower(btrim(t.album))
				= ANY (SELECT gkey FROM reattach_plan)
	`);

	return plan;
	});
}

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}
