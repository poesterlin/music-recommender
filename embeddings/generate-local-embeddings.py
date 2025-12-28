#!/usr/bin/env python3
"""
Generate embeddings for tracks missing them using local audio files.
Run locally with CPU: python embeddings/generate-local-embeddings.py
"""

import os
import psycopg2
from psycopg2.extras import DictCursor
import librosa
import openl3
import numpy as np
import re

AUDIO_DIR = os.getenv("AUDIO_DIR", "/music")
EMBEDDING_SIZE = 512


def sanitize(name):
    if not isinstance(name, str):
        return ""
    return name.replace("/", "_").replace(":", "_").replace("?", "_").strip()


def build_file_index(base_path):
    common_extensions = [".mp3", ".flac", ".wav", ".m4a", ".ogg"]
    index = {}

    for root, dirs, files in os.walk(base_path):
        for filename in files:
            name_part, ext = os.path.splitext(filename)
            if ext.lower() not in common_extensions:
                continue

            name_lower = name_part.lower()
            if name_lower not in index:
                index[name_lower] = []

            match = re.match(r"^(\d{2})\s*-\s*(.+)$", name_part, re.IGNORECASE)
            if match:
                alt_name = match.group(2).lower()
                if alt_name not in index:
                    index[alt_name] = []
                index[alt_name].append(os.path.join(root, filename))

            index[name_lower].append(os.path.join(root, filename))

    print(f"Indexed {len(index)} unique track names from {base_path}")

    sample_keys = sorted(list(index.keys()))[:10]
    print(f"Sample keys: {sample_keys}")

    return index


def find_local_audio_file(track_metadata, file_index):
    track_name = sanitize(track_metadata["name"])
    artist_names = track_metadata.get("artist", [])
    if isinstance(artist_names, str):
        artist_names = [artist_names]
    artist_names = [sanitize(a) for a in artist_names if a]

    print(f"  Looking for: '{track_name.lower()}' by {artist_names}")

    if not track_name or not artist_names:
        return None

    track_name_lower = track_name.lower()
    candidates = file_index.get(track_name_lower, [])

    if not candidates:
        return None

    if len(candidates) == 1:
        return candidates[0]

    album_name = sanitize(track_metadata.get("album", ""))
    if not album_name:
        return candidates[0]

    album_name_lower = album_name.lower()
    for path in candidates:
        if album_name_lower in path.lower():
            return path

    return candidates[0]


def process_audio_file(audio_path):
    audio, sr = librosa.load(audio_path, sr=None, mono=True, duration=60)
    if audio is None or len(audio) == 0:
        return None

    if sr != 48000:
        audio = librosa.resample(audio, orig_sr=sr, target_sr=48000)
        sr = 48000

    emb, _ = openl3.get_audio_embedding(audio, sr, embedding_size=EMBEDDING_SIZE)
    if emb is None or emb.shape[0] == 0:
        return None

    v = np.mean(emb, axis=0)
    if np.isnan(v).any():
        return None

    return v


def main():
    DATABASE_URL = os.getenv("DATABASE_URL")
    if not DATABASE_URL:
        raise ValueError("DATABASE_URL not set")

    print(f"Building file index from {AUDIO_DIR}...")
    file_index = build_file_index(AUDIO_DIR)

    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor(cursor_factory=DictCursor)

    cur.execute("""
        SELECT uri, name, artist, album
        FROM track
        WHERE embedding IS NULL
          AND (skip IS NULL OR skip = false)
    """)
    tracks = [dict(row) for row in cur.fetchall()]
    print(f"Found {len(tracks)} tracks without embeddings")

    processed = 0
    failed = 0

    for track in tracks:
        track_uri = track["uri"]
        print(f"Processing: {track.get('name', track_uri)}")

        audio_path = find_local_audio_file(track, file_index)
        if not audio_path:
            failed += 1
            continue

        embedding = process_audio_file(audio_path)
        if embedding is None:
            failed += 1
            continue

        vec_lit = "[" + ",".join(f"{x:.6f}" for x in embedding.tolist()) + "]"
        cur.execute(
            "UPDATE track SET embedding = %s::vector, updated_at = NOW() WHERE uri = %s",
            (vec_lit, track_uri),
        )
        conn.commit()
        processed += 1
        print(f"  Done ({embedding.shape[-1]} dims)")

    cur.close()
    conn.close()
    print(f"\nComplete: {processed} processed, {failed} failed")


if __name__ == "__main__":
    main()
