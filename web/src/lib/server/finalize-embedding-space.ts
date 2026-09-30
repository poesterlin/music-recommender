import { sql } from 'drizzle-orm';
import { db } from './db';

/** Called inside the upload transaction, with its space locked before writes. */
export async function finalizeEmbeddingSpace(tx: Pick<typeof db, 'execute'>, version: number) {
	const finalized = await tx.execute(sql`
		UPDATE embedding_space s
		SET mean_embedding = corpus.mean, track_count = corpus.n
		FROM (
			SELECT avg(embedding)::vector AS mean, count(*)::int AS n
			FROM track
			WHERE embedding_space_version = ${version}
				AND embedding IS NOT NULL AND COALESCE(skip, FALSE) = FALSE
		) corpus
		WHERE s.version = ${version} AND s.track_count = 0 AND corpus.n >= 2
		RETURNING s.version
	`);
	if (finalized.length === 0) return 0;
	const centered = await tx.execute(sql`
		UPDATE track
		SET embedding_centered = center_openl3_embedding(
			embedding, (SELECT mean_embedding FROM embedding_space WHERE version = ${version})
		)
		WHERE embedding_space_version = ${version} AND embedding IS NOT NULL
		RETURNING uri
	`);
	return centered.length;
}
