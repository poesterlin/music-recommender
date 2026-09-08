#!/usr/bin/env python3
"""
Index tracks from Music Assistant API into database.
Run locally: python embeddings/index-library.py
"""

import os
import requests
import psycopg2


def main():
    DATABASE_URL = os.getenv("DATABASE_URL")
    if not DATABASE_URL:
        raise ValueError("DATABASE_URL not set")

    HOST = os.getenv("HOST")
    TOKEN = os.getenv("TOKEN")
    CONFIG_ID = os.getenv("CONFIG_ID")

    if not HOST or not TOKEN or not CONFIG_ID:
        raise ValueError("HOST, TOKEN, and CONFIG_ID must be set")

    print(f"Fetching tracks from {HOST}...")

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {TOKEN}",
    }

    payload = {
        "limit": "100000",
        "library_only": "true",
        "config_entry_id": CONFIG_ID,
        "name": "",
        "media_type": "track",
    }

    response = requests.post(
        f"{HOST}/api/services/music_assistant/search?return_response",
        headers=headers,
        json=payload,
    )
    response.raise_for_status()

    data = response.json()
    tracks_data = data["service_response"]["tracks"]

    print(f"Found {len(tracks_data)} tracks from API")

    conn = psycopg2.connect(DATABASE_URL)
    cur = conn.cursor()

    inserted = 0

    for track in tracks_data:
        track_uri = track["uri"]
        track_name = track["name"]
        album_name = track["album"]["name"]
        artists_list = [a["name"] for a in track["artists"]]

        cur.execute(
            """
            INSERT INTO track (uri, name, artist, album)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (uri) DO NOTHING
            """,
            (track_uri, track_name, artists_list, album_name),
        )
        if cur.rowcount > 0:
            inserted += 1

    conn.commit()
    cur.close()
    conn.close()

    print(f"\nComplete: {inserted} tracks inserted")


if __name__ == "__main__":
    main()
