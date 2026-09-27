/**
 * Choosing k.
 *
 * There is no data-driven way to find k for this library, and we measured that
 * rather than assuming it. Three standard methods all fail on centered OpenL3
 * embeddings:
 *
 *  - The intra-similarity "elbow" rises smoothly with k while its per-cluster
 *    gain decays like 1/k. It never plateaus, so any knee the curve appears to
 *    have is an artifact of the metric, not a property of the data.
 *  - Silhouette is negative at every k we measured (-1.98 at k=8, -1.92 at
 *    k=192) and essentially flat. Centering puts the library on a sphere, so
 *    clusters are angular slices with overlapping spreads rather than the
 *    compact convex blobs silhouette assumes.
 *  - A 2-means split test finds no splittable cluster at any k from 4 to 96.
 *    The space is a smooth unimodal blob, so every k is an equally arbitrary
 *    partition of it.
 *
 * What *is* real is separation: inter-centroid similarity sits near zero, so
 * whatever k we pick, the clusters we get are genuinely distinct from each
 * other. k therefore controls granularity, not quality.
 *
 * So the honest control is how many tracks a cluster should hold, and the rule
 * is logarithmic because doubling the library should not double the number of
 * vibes:
 *
 *     k = 5 * ln(N),  capped so no cluster holds fewer than MIN_TRACKS_PER_CLUSTER
 *
 * The constant is chosen so a 26,144-track library lands on k=51 - the
 * partition this project has been running, which measures well (inter-centroid
 * similarity -0.013, cluster sizes 199-929, none under 100 tracks).
 *
 * The cap only binds on small libraries, where a bare logarithm would hand a
 * 1,000-track library 35 clusters of 29 tracks each. That is too few tracks to
 * name a cluster reliably from its dominant artists, or to sample from one for
 * playback.
 */

/** Chosen so 26,144 clusterable tracks -> k=51, matching the running partition. */
export const LOG_COEFFICIENT = 5;

/** A cluster below this cannot be named reliably or sampled for playback. */
export const MIN_TRACKS_PER_CLUSTER = 60;

/** Below this, "vibes" stops being a useful abstraction. */
export const MIN_K = 4;

/** A sanity ceiling. Reached only past ~10^34 tracks, so it never binds in practice. */
export const MAX_K = 400;

export type KClamp = 'min' | 'max' | null;

export type KDerivation = {
	/** Tracks eligible for clustering: embedded, not skipped. */
	clusterable: number;
	/** The recommended k. */
	k: number;
	/** k from the logarithm alone, before the size cap. */
	logK: number;
	/** The cap implied by MIN_TRACKS_PER_CLUSTER. */
	capK: number;
	/** True when the size cap, not the logarithm, decided k. */
	capped: boolean;
	/** Which bound, if any, was applied. */
	clamped: KClamp;
	/** Resulting mean cluster size. */
	meanPerCluster: number;
	/** One sentence a person can read and agree or disagree with. */
	explanation: string;
};

/**
 * Pick k for a library of `clusterable` tracks.
 *
 * Pure and total: it never throws, and callers decide what to do with 0 (there
 * is nothing to cluster) or 1 (a single track is its own cluster).
 */
export function deriveClusterCount(clusterable: number): KDerivation {
	const n = Number.isFinite(clusterable) ? Math.max(0, Math.floor(clusterable)) : 0;

	if (n === 0) {
		return {
			clusterable: 0,
			k: 0,
			logK: 0,
			capK: 0,
			capped: false,
			clamped: null,
			meanPerCluster: 0,
			explanation: 'No embedded tracks yet, so there is nothing to cluster.'
		};
	}

	const logK = Math.max(MIN_K, Math.round(LOG_COEFFICIENT * Math.log(n)));
	const capK = Math.max(1, Math.floor(n / MIN_TRACKS_PER_CLUSTER));
	const capped = logK > capK;
	const uncapped = Math.min(logK, capK);

	let k = uncapped;
	let clamped: KClamp = null;
	if (k < MIN_K) {
		k = MIN_K;
		clamped = 'min';
	} else if (k > MAX_K) {
		k = MAX_K;
		clamped = 'max';
	}

	const meanPerCluster = Math.round(n / k);
	const explanation = capped
		? `${n.toLocaleString()} tracks, but 5·ln(N) would ask for ${logK} clusters of ` +
			`~${Math.round(n / logK)} tracks each. Capped at ${k} so every cluster keeps at ` +
			`least ${MIN_TRACKS_PER_CLUSTER} tracks to name and sample from.`
		: `${n.toLocaleString()} tracks · 5·ln(N) = ${logK} clusters · ~${meanPerCluster} ` +
			`tracks each.`;

	return { clusterable: n, k, logK, capK, capped, clamped, meanPerCluster, explanation };
}
