#!/usr/bin/env python3
"""
Generate embeddings for tracks missing them.
Run locally with GPU: python embeddings/generate-embeddings.py
"""

import os
import psycopg2
from psycopg2.extras import DictCursor
import boto3
from botocore.config import Config
import librosa
import openl3
import numpy as np
import io
import traceback
import re


def sanitize(name_component):
    if not isinstance(name_component, str):
        return ""
    return name_component.replace("/", "_").replace(":", "_").replace("?", "_").strip()


def process_s3_audio_object(s3_client, bucket_name, s3_object_key):
    try:
        response = s3_client.get_object(Bucket=bucket_name, Key=s3_object_key)
        audio_data = response["Body"].read()

        if not audio_data:
            return None

        with io.BytesIO(audio_data) as audio_stream:
            audio, sr = librosa.load(audio_stream, sr=None, mono=True)

        if audio is None or len(audio) == 0:
            return None

        if sr != 48000:
            audio = librosa.resample(audio, orig_sr=sr, target_sr=48000)
            sr = 48000

        emb, _ = openl3.get_audio_embedding(audio, sr, embedding_size=512)
        if emb is None or emb.shape[0] == 0:
            return None

        v = np.mean(emb, axis=0)
        if np.isnan(v).any():
            return None

        return v

    except Exception:
        traceback.print_exc()
        return None


def find_s3_audio_object(track_metadata, s3_client, bucket_name):
    try:
        track_name_sanitized = sanitize(track_metadata.get("name"))
        album_name_sanitized = sanitize(track_metadata.get("album"))

        raw_artists = track_metadata.get("artists", []) or track_metadata.get(
            "artist", []
        )
        if isinstance(raw_artists, str):
            raw_artists = [raw_artists]

        artist_names_sanitized = [
            sanitize(a) for a in raw_artists if isinstance(a, str) and a.strip()
        ]

        if not track_name_sanitized or not artist_names_sanitized:
            return None

        common_extensions = [".mp3", ".flac", ".wav", ".m4a", ".ogg"]
        track_name_sanitized_lower = track_name_sanitized.lower()

        for artist_name in artist_names_sanitized:
            if not artist_name:
                continue

            s3_prefix = (
                f"{artist_name}/{album_name_sanitized}/"
                if album_name_sanitized
                else f"{artist_name}/"
            )

            paginator = s3_client.get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=bucket_name, Prefix=s3_prefix):
                if "Contents" not in page:
                    continue
                for item in page["Contents"]:
                    object_key = item["Key"]
                    filename_with_ext = os.path.basename(object_key)
                    name_part, ext_part = os.path.splitext(filename_with_ext)

                    if ext_part.lower() not in common_extensions:
                        continue

                    if name_part.lower() == track_name_sanitized_lower:
                        return object_key

                    match = re.match(r"^(\d{2})\s*-\s*(.+)$", name_part, re.IGNORECASE)
                    if match and match.group(2).lower() == track_name_sanitized_lower:
                        return object_key
        return None
    except Exception:
        return None


def main():
    DATABASE_URL = os.getenv("DATABASE_URL")
    S3_ENDPOINT_URL = os.getenv("s3_endpoint_url")
    S3_ACCESS_KEY_ID = os.getenv("s3_access_key_id")
    S3_SECRET_ACCESS_KEY = os.getenv("s3_secret_access_key")
    S3_BUCKET_NAME = os.getenv("s3_bucket_name")
    S3_REGION_NAME = os.getenv("s3_region_name", "auto")

    s3_client = boto3.client(
        "s3",
        endpoint_url=S3_ENDPOINT_URL,
        aws_access_key_id=S3_ACCESS_KEY_ID,
        aws_secret_access_key=S3_SECRET_ACCESS_KEY,
        region_name=S3_REGION_NAME,
        config=Config(
            s3={
                "request_checksum_calculation": "WHEN_REQUIRED",
                "response_checksum_validation": "WHEN_REQUIRED",
            }
        ),
    )

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

        s3_key = find_s3_audio_object(track, s3_client, S3_BUCKET_NAME)
        if not s3_key:
            print(f"  Not found in S3")
            failed += 1
            continue

        embedding = process_s3_audio_object(s3_client, S3_BUCKET_NAME, s3_key)
        if embedding is None:
            print(f"  Failed to generate embedding")
            failed += 1
            continue

        vec_lit = "[" + ",".join(f"{x:.6f}" for x in embedding.tolist()) + "]"
        cur.execute(
            "UPDATE track SET embedding = %s::vector WHERE uri = %s",
            (vec_lit, track_uri),
        )
        conn.commit()
        processed += 1
        print(f"  Done (embedding {embedding.shape[-1]} dims)")

    cur.close()
    conn.close()
    print(f"\nComplete: {processed} processed, {failed} failed")


if __name__ == "__main__":
    main()
