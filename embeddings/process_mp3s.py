import os
import librosa
import openl3
import numpy as np
import psycopg2
import traceback
import sys

def sanitize(name):
    return name.replace("/", "_").replace(":", "_").replace("?", "_").strip()

AUDIO_DIR = "/music"
EMBEDDING_SIZE = 256

def process_file(mp3_path, track_uri, cur):
    try:
        print(f"Loading audio: {mp3_path}")
        audio, sr = librosa.load(mp3_path, sr=None, mono=True)
        if audio is None or len(audio) == 0:
            print(f"Audio file {mp3_path} is empty or could not be loaded.")
            return False

        # Resample if needed
        if sr != 48000:
            try:
                audio = librosa.resample(audio, orig_sr=sr, target_sr=48000)
                sr = 48000
            except Exception as e:
                print(f"Resampling failed for {mp3_path}: {e}")
                traceback.print_exc()
                return False

        try:
            emb, _ = openl3.get_audio_embedding(
                audio, sr,
                input_repr="mel256",
                content_type="music",
                embedding_size=EMBEDDING_SIZE,
                verbose=0
            )
        except Exception as e:
            print(f"openl3 embedding failed for {mp3_path}: {e}")
            traceback.print_exc()
            return False

        if emb is None or emb.shape[0] == 0:
            print(f"openl3 returned empty embedding for {mp3_path}")
            return False

        emb_mean = np.mean(emb, axis=0)
        if np.isnan(emb_mean).any():
            print(f"Embedding for {mp3_path} contains NaN values.")
            return False

        try:
            cur.execute(
                """
                UPDATE track
                SET embedding = %s
                WHERE uri = %s
                """,
                (emb_mean.tolist(), track_uri)
            )
            print(f"Processed and updated DB: {mp3_path}")
            return True
        except Exception as e:
            print(f"Database update failed for {track_uri}: {e}")
            traceback.print_exc()
            return False

    except Exception as e:
        print(f"Error processing {mp3_path} ({track_uri}): {e}")
        traceback.print_exc()
        return False

def find_audio_file(track_metadata, base_path):
    try:
        track_name = sanitize(track_metadata["name"])
        album_name = sanitize(track_metadata["album"])
        artist_names = [sanitize(a) for a in track_metadata["artists"]]

        possible_paths = []
        for artist_name in artist_names:
            possible_paths.append(os.path.join(base_path, artist_name, album_name, f"{track_name}.mp3"))

        for path in possible_paths:
            if os.path.exists(path):
                print(f"Found file at: {path}")
                return path
            else:
                print(f"Attempted path not found: {path}")

        print(f"Could not find file for track: {track_metadata['name']} by {artist_names}")
        return None
    except Exception as e:
        print(f"Error in find_audio_file: {e}")
        traceback.print_exc()
        return None

def main():
    try:
        conn = psycopg2.connect(os.getenv("DATABASE_URL"))
        cur = conn.cursor()
    except Exception as e:
        print(f"Could not connect to database: {e}")
        traceback.print_exc()
        sys.exit(1)

    try:
        cur.execute(
            """
            SELECT uri, name, artist, album FROM track WHERE embedding IS NULL
            """
        )
        rows = cur.fetchall()
    except Exception as e:
        print(f"Database query failed: {e}")
        traceback.print_exc()
        cur.close()
        conn.close()
        sys.exit(1)

    for row in rows:
        track_uri = row[0]
        track_name = row[1]
        artist_names = row[2]
        album_name = row[3]

        if isinstance(artist_names, str):
            artist_names = [artist_names]

        track_metadata = {
            "uri": track_uri,
            "name": track_name,
            "artists": artist_names,
            "album": album_name
        }

        mp3_path = find_audio_file(track_metadata, AUDIO_DIR)
        if mp3_path:
            success = process_file(mp3_path, track_uri, cur)
            if not success:
                print(f"Failed to process {mp3_path} ({track_uri}), skipping.")
        else:
            print(f"Audio file not found for {track_uri}, skipping.")

    try:
        conn.commit()
    except Exception as e:
        print(f"Database commit failed: {e}")
        traceback.print_exc()
    finally:
        cur.close()
        conn.close()

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"Fatal error: {e}")
        traceback.print_exc()
        sys.exit(1)
