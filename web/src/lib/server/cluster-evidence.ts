import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';

export type EvidenceTrack = {
	name: string;
	artists: string[];
	albumImage: string | null;
	similarity: number;
};

export type ClusterEvidence = {
	clusterId: number;
	trackCount: number;
	/** Dominant artists among the most central tracks. */
	artists: Array<{ name: string; count: number }>;
	/** Most central tracks, closest to the centroid. */
	tracks: EvidenceTrack[];
};

type Row = {
	cluster_id: number;
	uri: string;
	name: string;
	artist: string[];
	album_image: string | null;
	similarity: string | number;
};

/**
 * Naming evidence for a cluster: the tracks closest to its centroid plus the
 * artists that dominate them.
 *
 * Centrality is the useful signal here — a cluster's most representative
 * tracks are the ones nearest its centroid, and their repeated artists are a
 * far better summary than the cluster as a whole, which is diluted by
 * boundary cases.
 *
 * Sampled so this stays cheap enough for an on-demand request over 29k
 * vectors; the API is single-user and read-only.
 */
export async function getClusterEvidence(
	clusterId: number,
	options: { limit?: number } = {}
): Promise<ClusterEvidence | null> {
	const limit = Math.min(Math.max(options.limit ?? 6, 1), 12);

	try {
		const countRows = (await db.execute(sql`
			SELECT count(*)::bigint AS n
			FROM track
			WHERE cluster_id = ${clusterId} AND embedding_centered IS NOT NULL
		`)) as unknown as Array<{ n: number }>;
		const trackCount = Number(countRows[0]?.n ?? 0);
		if (trackCount === 0) return null;

		// A random subset keeps this cheap over 29k vectors; central tracks are
		// the top of a 200-row sample, so a small sample would still find them.
		// LIMIT is applied before the distance sort for the same reason.
		const sampleSize = Math.max(60, limit * 8);
		const rows = (await db.execute(sql`
			SELECT t.cluster_id, t.uri, t.name, t.artist, t.album_image,
				1 - (t.embedding_centered <=> c.embedding) AS similarity
			FROM (
				SELECT cluster_id, uri, name, artist, album_image, embedding_centered
				FROM track
				WHERE cluster_id = ${clusterId} AND embedding_centered IS NOT NULL
				ORDER BY random()
				LIMIT ${sampleSize}
			) t
			JOIN cluster_centroid c ON c.cluster_id = t.cluster_id
			ORDER BY t.embedding_centered <=> c.embedding
			LIMIT ${limit * 4}
		`)) as unknown as Row[];

		if (rows.length === 0) return null;

		const artists = new Map<string, number>();
		const tracks: EvidenceTrack[] = [];
		const seen = new Set<string>();

		for (const row of rows) {
			const key = row.name.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			tracks.push({
				name: row.name,
				artists: row.artist ?? [],
				albumImage: row.album_image ?? null,
				similarity: Number(row.similarity)
			});
			if (tracks.length >= limit) break;
		}

		// Count artist repeats across the central set, not the whole cluster.
		for (const row of rows.slice(0, 60)) {
			for (const artist of row.artist ?? []) {
				artists.set(artist, (artists.get(artist) ?? 0) + 1);
			}
		}

		return {
			clusterId,
			trackCount,
			artists: [...artists.entries()]
				.map(([name, count]) => ({ name, count }))
				.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
				.slice(0, 6),
			tracks
		};
	} catch (error) {
		console.error('[cluster-evidence] failed for cluster', clusterId, error);
		return null;
	}
}
