FROM python:3.11-slim@sha256:da047cb8f9d1d98e5c070f5300ba9f7274e33b8fc0e5be5ed88740aed1b95ba9

RUN apt-get update && \
    apt-get install -y libsndfile1 ffmpeg && \
    rm -rf /var/lib/apt/lists/*

COPY requirements.txt /workspace/requirements.txt
RUN pip install --no-cache-dir -r /workspace/requirements.txt

WORKDIR /workspace

COPY index-library.py /workspace/index-library.py
COPY generate-local-embeddings.py /workspace/generate-local-embeddings.py
COPY worker.py worker_api.py /workspace/
COPY migrate-centered-embeddings.py /workspace/migrate-centered-embeddings.py

CMD ["python", "worker.py", "--source-mode", "api"]
