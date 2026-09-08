FROM python:3.11-slim

RUN apt-get update && \
    apt-get install -y libsndfile1 ffmpeg && \
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir openl3 librosa psycopg2-binary numpy requests

WORKDIR /workspace

COPY index-library.py /workspace/index-library.py
COPY generate-local-embeddings.py /workspace/generate-local-embeddings.py
