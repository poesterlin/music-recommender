import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';

/**
 * Cover art URL helper.
 *
 * Cover paths are stored on `track.album_image` as a bare imageproxy path.
 * The upstream host is deployment-specific and private, so it is applied here
 * at render time from MUSIC_HOST. Sizes are fixed by Music Assistant; the
 * imageproxy rejects anything else with a 400.
 */
/** Up to two album covers standing in for a cluster. */
export type ClusterCovers = { primary: string; secondary: string | null };

/** Assigned track count per cluster, for tile captions. */
export async function getClusterTrackCounts(): Promise<Record<number, number>> {
	try {
		const rows = (await db.execute(sql`
			SELECT cluster_id, count(*)::bigint AS n
			FROM track
			WHERE cluster_id >= 0
			GROUP BY cluster_id
		`)) as unknown as Array<{ cluster_id: number; n: number }>;
		const out: Record<number, number> = {};
		for (const row of rows) out[row.cluster_id] = Number(row.n);
		return out;
	} catch {
		return {};
	}
}

/**
 * One or two representative covers per cluster, without loading every vector.
 *
 * Centroids carry no art, so this takes the most common albums in each
 * cluster. Album frequency is a reasonable proxy for "typical of this cluster"
 * and keeps the query to a grouped scan rather than a 29k-row sort.
 */
export async function getClusterCovers(): Promise<Record<number, ClusterCovers>> {
	try {
		const rows = (await db.execute(sql`
			WITH album_counts AS (
				SELECT cluster_id, album, album_image, count(*)::bigint AS album_tracks
				FROM track
				WHERE cluster_id >= 0 AND album_image IS NOT NULL
				GROUP BY cluster_id, album, album_image
			),
			ranked AS (
				SELECT cluster_id, album_image,
					row_number() OVER (
						PARTITION BY cluster_id ORDER BY album_tracks DESC, album ASC
					) AS rn
				FROM album_counts
			)
			SELECT cluster_id,
				max(album_image) FILTER (WHERE rn = 1) AS primary,
				max(album_image) FILTER (WHERE rn = 2) AS secondary
			FROM ranked
			WHERE rn <= 2
			GROUP BY cluster_id
		`)) as unknown as Array<{
			cluster_id: number;
			primary: string | null;
			secondary: string | null;
		}>;

		const out: Record<number, ClusterCovers> = {};
		for (const row of rows) {
			if (!row.primary) continue;
			out[row.cluster_id] = { primary: row.primary, secondary: row.secondary };
		}
		return out;
	} catch {
		return {};
	}
}
