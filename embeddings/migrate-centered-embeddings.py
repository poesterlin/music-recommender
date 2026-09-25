#!/usr/bin/env python3
"""Create the frozen centered OpenL3 space and backfill centered vectors.

This never reruns audio analysis: it derives L2-normalized centered vectors from
the raw embeddings already stored in Postgres.
"""

import os
import psycopg2
import numpy as np

SPACE_VERSION = 1
MODEL = "openl3-512"
FETCH_SIZE = 500


def parse_vector(value):
    if value is None:
        return None
    if isinstance(value, np.ndarray):
        return value.astype(np.float64, copy=False)
    return np.fromstring(str(value).strip().strip("[]"), sep=",", dtype=np.float64)


def vector_literal(value):
    return "[" + ",".join(f"{x:.8f}" for x in value.tolist()) + "]"


def ensure_space(cur):
    cur.execute(
        """
        SELECT mean_embedding::text, track_count
        FROM embedding_space
        WHERE version = %s
        """,
        (SPACE_VERSION,),
    )
    existing = cur.fetchone()
    if existing:
        print(
            f"Using frozen embedding space v{SPACE_VERSION} "
            f"({existing[1]} source tracks)"
        )
        return parse_vector(existing[0]), int(existing[1])

    print("Computing global OpenL3 mean from existing raw embeddings...")
    cur.execute(
        """
        SELECT count(*)::int, avg(embedding)::vector::text
        FROM track
        WHERE embedding IS NOT NULL
        """
    )
    track_count, mean_text = cur.fetchone()
    if not track_count or mean_text is None:
        raise RuntimeError("No raw embeddings are available to center")

    mean = parse_vector(mean_text)
    if len(mean) != 512:
        raise RuntimeError(f"Expected a 512-dimensional mean, got {len(mean)}")

    cur.execute(
        """
        INSERT INTO embedding_space (version, model, mean_embedding, track_count)
        VALUES (%s, %s, %s::vector, %s)
        """,
        (SPACE_VERSION, MODEL, vector_literal(mean), track_count),
    )
    print(f"Created embedding space v{SPACE_VERSION} from {track_count} tracks")
    return mean, track_count


def main():
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise ValueError("DATABASE_URL is not set")

    conn = psycopg2.connect(database_url)
    conn.autocommit = False
    cur = conn.cursor()

    try:
        mean, source_count = ensure_space(cur)
        conn.commit()

        read_cur = conn.cursor()
        write_cur = conn.cursor()
        read_cur.execute(
            """
            SELECT uri, embedding::text
            FROM track
            WHERE embedding IS NOT NULL
              AND (
                embedding_centered IS NULL
                OR embedding_space_version IS DISTINCT FROM %s
              )
            ORDER BY uri
            """,
            (SPACE_VERSION,),
        )

        processed = 0
        while True:
            rows = read_cur.fetchmany(FETCH_SIZE)
            if not rows:
                break

            updates = []
            for uri, raw_text in rows:
                raw = parse_vector(raw_text)
                if len(raw) != len(mean):
                    raise RuntimeError(f"Embedding dimension mismatch for {uri}")
                centered = raw - mean
                norm = np.linalg.norm(centered)
                if not np.isfinite(norm) or norm == 0:
                    raise RuntimeError(f"Invalid centered vector norm for {uri}")
                updates.append(
                    (vector_literal(centered / norm), SPACE_VERSION, uri)
                )

            write_cur.executemany(
                """
                UPDATE track
                SET embedding_centered = %s::vector,
                    embedding_space_version = %s,
                    updated_at = NOW()
                WHERE uri = %s
                """,
                updates,
            )
            processed += len(updates)
            print(f"Centered {processed} tracks", flush=True)

        read_cur.close()
        write_cur.close()
        conn.commit()

        cur.execute(
            """
            SELECT count(*)::int
            FROM track
            WHERE embedding IS NOT NULL
              AND (
                embedding_centered IS NULL
                OR embedding_space_version IS DISTINCT FROM %s
              )
            """,
            (SPACE_VERSION,),
        )
        remaining = int(cur.fetchone()[0])
        if remaining:
            raise RuntimeError(f"{remaining} raw embeddings remain uncentered")

        print(
            f"Complete: centered {processed} tracks in embedding space v{SPACE_VERSION} "
            f"from {source_count} source embeddings"
        )
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
