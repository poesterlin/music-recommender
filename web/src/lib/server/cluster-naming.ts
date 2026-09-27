import { and, eq, sql } from 'drizzle-orm';
import { db } from './db';
import { clusterRunMatchTable } from './schema';
import { getActiveRunId, isHumanNamed } from './active-clusters';

/** How many dominant artists make up a name. Three is enough to be unique. */
const NAME_ARTISTS = 3;

export type AutoName = {
	clusterId: number;
	trackCount: number;
	/** The name that would be written. */
	name: string;
	artists: string[];
	/** True when a person has already named this cluster. */
	named: boolean;
};

function titleCase(artist: string): string {
	// Leave deliberate stylings alone (AC/DC, A-ha, P!nk, t.A.T.u.) and only
	// adjust case when the value is a flat lowercase or uppercase run.
	const lower = artist.toLowerCase();
	if (artist !== lower && artist !== artist.toUpperCase()) return artist;
	return lower.replace(
		/(^|[\s('&.-])([a-z])/g,
		(_, lead: string, ch: string) => lead + ch.toUpperCase()
	);
}

/**
 * Derive a name for every cluster from its dominant artists.
 *
 * A single dominant artist is not enough: on a real library the top artist
 * names six different clusters, because one act's catalogue spans several
 * genuinely different sound groups. Three artists is enough to separate all of
 * them, so the name is the top three joined together.
 *
 * This is fully deterministic and needs no network access, so every cluster
 * always gets a usable name rather than a placeholder.
 */
export async function suggestClusterNames(): Promise<AutoName[]> {
	const rows = (await db.execute(sql`
		WITH scoped AS (
			SELECT cluster_id, artist, name
			FROM track
			WHERE cluster_id >= 0 AND COALESCE(skip, FALSE) = FALSE
		),
		per_artist AS (
			SELECT cluster_id, lower(artist[1]) AS artist_key, count(*)::bigint AS tracks
			FROM scoped
			GROUP BY cluster_id, artist_key
		),
		ranked AS (
			SELECT cluster_id, artist_key, tracks,
				row_number() OVER (
					PARTITION BY cluster_id ORDER BY tracks DESC, artist_key ASC
				) AS rank
			FROM per_artist
		),
		names AS (
			SELECT cluster_id,
				string_agg(artist_key, ', ' ORDER BY rank)
					FILTER (WHERE rank <= ${NAME_ARTISTS}) AS label,
				array_agg(artist_key ORDER BY rank)
					FILTER (WHERE rank <= ${NAME_ARTISTS}) AS artists
			FROM ranked
			GROUP BY cluster_id
		),
		counts AS (
			SELECT cluster_id, count(*)::bigint AS track_count
			FROM scoped GROUP BY cluster_id
		),
		existing AS (
			SELECT cluster_id, display_name
			FROM cluster_run_match
			WHERE run_id = (
				SELECT id FROM cluster_run WHERE status = 'applied'
				ORDER BY applied_at DESC NULLS LAST, id DESC LIMIT 1
			)
		)
		SELECT n.cluster_id, c.track_count, n.label, n.artists, e.display_name
		FROM names n
		JOIN counts c ON c.cluster_id = n.cluster_id
		LEFT JOIN existing e ON e.cluster_id = n.cluster_id
		ORDER BY n.cluster_id
	`)) as unknown as Array<{
		cluster_id: number;
		track_count: number;
		label: string | null;
		artists: string[] | null;
		display_name: string | null;
	}>;

	return rows.map((row) => {
		// The SQL lowercases artist names for grouping; restore a readable form
		// here rather than in the query, so deliberate stylings survive.
		const artists = (row.artists ?? []).map(titleCase);
		return {
			clusterId: Number(row.cluster_id),
			trackCount: Number(row.track_count),
			name: artists.length > 0 ? artists.join(', ') : `Cluster ${row.cluster_id}`,
			artists,
			named: isHumanNamed(row.display_name)
		};
	});
}

/** Write the derived names for the given clusters. Returns how many rows changed. */
export async function applyAutoNames(clusterIds: number[]): Promise<number> {
	if (clusterIds.length === 0) return 0;
	const suggestions = await suggestClusterNames();
	const wanted = new Map(
		suggestions.filter((s) => clusterIds.includes(s.clusterId)).map((s) => [s.clusterId, s.name])
	);
	if (wanted.size === 0) return 0;

	const runId = await getActiveRunId();
	if (runId === null) return 0;

	// One statement per cluster, because each row gets a *different* name. That
	// needs a VALUES join (`UPDATE ... FROM (VALUES ...)`) to batch, which the
	// query builder cannot express — so this stays a loop. What it no longer does
	// is hand-assemble SQL, and it reports rows actually changed rather than
	// names it intended to write.
	let changed = 0;
	for (const [clusterId, name] of wanted) {
		const updated = await db
			.update(clusterRunMatchTable)
			.set({ displayName: name })
			.where(
				and(eq(clusterRunMatchTable.runId, runId), eq(clusterRunMatchTable.clusterId, clusterId))
			)
			.returning({ clusterId: clusterRunMatchTable.clusterId });
		changed += updated.length;
	}
	return changed;
}
