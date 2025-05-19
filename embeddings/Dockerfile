FROM python:3.10-slim

# Install system dependencies
RUN apt-get update && \
    apt-get install -y libsndfile1 ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# Install Python dependencies
RUN pip install --no-cache-dir openl3 librosa soundfile psycopg2-binary

WORKDIR /workspace

# Copy your processing script into the container
COPY process_mp3s.py /workspace/process_mp3s.py

ENTRYPOINT ["python", "process_mp3s.py"]
