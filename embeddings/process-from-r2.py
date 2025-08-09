import modal

# --- Modal App Definition ---
app = modal.App("r2-audio-embedding")
kv = modal.Dict.from_name("kv", create_if_missing=True)


# --- Modal Image with Dependencies ---
image = modal.Image.from_registry(
    "tensorflow/tensorflow:2.15.0-gpu"
).pip_install(
    "librosa",
    "openl3",
    "boto3",
    "soundfile",
    "audioread",
    "scipy",
    "numpy"
)

# --- Helper Functions (unchanged from your script) ---
def sanitize(name_component):
    if not isinstance(name_component, str):
        return ""
    return (
        name_component.replace("/", "_")
        .replace(":", "_")
        .replace("?", "_")
        .strip()
    )


def process_s3_audio_object(s3_client, bucket_name, s3_object_key, track_uri):
    import numpy as np
    from botocore.config import Config
    import librosa
    import openl3
    import io
    import traceback
    from botocore.exceptions import ClientError
    try:
        # print(f"Downloading audio from S3: s3://{bucket_name}/{s3_object_key}")
        response = s3_client.get_object(Bucket=bucket_name, Key=s3_object_key)
        audio_data = response["Body"].read()

        if not audio_data:
            # print(f"S3 object s3://{bucket_name}/{s3_object_key} is empty.")
            return None

        with io.BytesIO(audio_data) as audio_stream:
            audio, sr = librosa.load(audio_stream, sr=None, mono=True)

        if audio is None or len(audio) == 0:
            # print(f"Audio from S3 object s3://{bucket_name}/{s3_object_key} is empty or could not be loaded.")
            return None

        if sr != 48000:
            try:
                audio = librosa.resample(audio, orig_sr=sr, target_sr=48000)
                sr = 48000
            except Exception as e:
                # print(f"Resampling failed: {e}")
                traceback.print_exc()
                return None

        try:
            emb, _ = openl3.get_audio_embedding(audio, sr, embedding_size=512)
            if emb is None or emb.shape[0] == 0:
                return None
            v = np.mean(emb, axis=0)
            if np.isnan(v).any():
                return None
            return v
        except Exception as e:
            # print(f"openl3 embedding failed: {e}")
            traceback.print_exc()
            return None

    except ClientError as e:
        # print(f"S3 error: {e}")
        return None
    except Exception as e:
        # print(f"Generic error: {e}")
        traceback.print_exc()
        return None


def find_s3_audio_object(track_metadata, s3_client, bucket_name):
    import numpy as np
    import os
    import re

    try:
        track_name_sanitized = sanitize(track_metadata.get("name"))
        album_name_sanitized = sanitize(track_metadata.get("album"))

        raw_artists = track_metadata.get("artists", [])
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

            s3_prefix = f"{artist_name}/{album_name_sanitized}/" if album_name_sanitized else f"{artist_name}/"

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
        # traceback.print_exc()
        return None


# --- Modal Function ---
@app.function(image=image, secrets=[modal.Secret.from_name("r2-credentials")], gpu="T4", timeout=36000)
def process_tracks():
    import numpy as np
    import boto3
    import os
    import json
    import random
    from botocore.config import Config
    
    # import librosa
    # import openl3
    # import io
    # import re
    # import traceback
    # from botocore.exceptions import ClientError


    s3_endpoint_url = os.getenv("s3_endpoint_url")
    s3_access_key_id = os.getenv("s3_access_key_id")
    s3_secret_access_key = os.getenv("s3_secret_access_key")
    s3_bucket_name = os.getenv("s3_bucket_name")

    s3_boto_config = Config(
        s3={
            "request_checksum_calculation": "WHEN_REQUIRED",
            "response_checksum_validation": "WHEN_REQUIRED",
        }
    )
    s3_client = boto3.client(
        "s3",
        endpoint_url=s3_endpoint_url,
        aws_access_key_id=s3_access_key_id,
        aws_secret_access_key=s3_secret_access_key,
        region_name=os.getenv("s3_region_name"),
        config=s3_boto_config,
    )

    s3_client.download_file(s3_bucket_name, "tracks.json", "/tmp/tracks.json")
    with open("/tmp/tracks.json") as f:
        tracks = json.load(f)

    random.shuffle(tracks)

    processed_count = 0
    failed_count = 0

    output_sql_path = "/root/embeddings_updates.sql"

    with open(output_sql_path, "w") as out:
        out.write("-- Generated embeddings updates\n\n")
        for t in tracks:
            track_uri = t["uri"]
            
            if kv.get(track_uri):
                continue

            # print(f"→ Processing {track_uri}")
            s3_object_key = find_s3_audio_object(t, s3_client, s3_bucket_name)
            if s3_object_key:
                emb = process_s3_audio_object(s3_client, s3_bucket_name, s3_object_key, track_uri)
                if emb is not None:
                    vec_lit = "[" + ",".join(f"{x:.6f}" for x in emb.tolist()) + "]"
                    sql = (
                        f"UPDATE track\n"
                        f"SET embedding = '{vec_lit}'::vector\n"
                        f"WHERE uri = '{track_uri}';\n\n"
                    )
                    kv[track_uri] = emb.tolist()
                    print(sql)
                    out.write(sql)
                    out.flush()
                    processed_count += 1
                else:
                    failed_count += 1
            else:
                failed_count += 1

    # print(f"Processing complete. Processed: {processed_count}, Failed: {failed_count}")


# --- Local Entrypoint ---
@app.local_entrypoint()
def main():
    # These paths must be accessible locally when you run `modal run`
    process_tracks.remote()