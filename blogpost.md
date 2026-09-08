# Building a Context-Aware Background Music System with Audio Embeddings and K-Means Clustering

I run Music Assistant as my home audio backend. It handles multi-room playback, library management, and speaker grouping. The gap was intelligent background music — something that reads the room without requiring manual playlist curation every time. I built a recommendation pipeline that lives between Music Assistant and Home Assistant: it ingests raw audio, computes embeddings, clusters the library into perceptual "vibes," and serves context-aware playlists via webhook.

## From Waveform to Vector

The pipeline starts by listening. Not reading tags, not parsing playlists — actually listening to the audio.

I use [OpenL3](https://openl3.readthedocs.io/) to generate 512-dimensional embeddings directly from raw waveforms. OpenL3 is a self-supervised model trained on AudioSet. It captures timbre, rhythm, instrumentation, and mood in a way that metadata — genre tags, artist names, user playlists — simply cannot. A soft acoustic ballad and a piano-driven pop song might share tags; their embeddings diverge. The model hears what humans sometimes miss.

The ingestion layer handles two storage backends. For local libraries, it indexes the filesystem, maps track metadata to file paths, loads the first 60 seconds of audio with librosa, resamples to 48kHz, and runs inference. Frame-level embeddings are mean-pooled into a single track vector. For cloud-backed libraries (I use object storage), it streams bytes directly into memory, avoiding disk entirely. Both paths write vectors to Postgres using the pgvector extension.

A separate sync job pulls the full track metadata from the Music Assistant API and upserts it into the database. Embeddings are generated afterward against this catalog. The pipeline is idempotent: re-run catalog sync, re-run embedding generation, missing vectors get filled in.

## Clustering the Library into Vibes

Once every track has a 512-dimensional vector, I run K-Means++ on the full library.

Every embedding is L2-normalized before clustering. I use k=60. Why 60? It is granular enough to separate "Melodic R&B" from "Contemporary Breezy Pop" without fragmenting subgenres into noise. Too few clusters and distinct vibes collapse into each other. Too many and you get micro-clusters that are impossible to reason about.

The interesting part is seed selection. After clustering, I do not use the raw centroids. Centroids are mathematical abstractions — they do not correspond to actual songs. Instead, I find, for each cluster, the real track whose embedding has the smallest cosine distance to the centroid. These are the *seeds*: the most archetypal representatives of each vibe. Cluster 14 becomes "High-Energy Dance & Club Pop" not because I labeled it that way, but because the track sitting closest to its center empirically sounds like that.

If a cluster is unexpectedly empty after filtering, the system falls back to the nearest valid track. Seeds give me human-interpretable anchors for what each cluster actually represents.

Cluster assignments are persisted back to the database in chunked, batched updates. This avoids round-trip overhead and keeps the assignment atomic across the full library.

## The Recommendation Engine

This is where the pipeline gets interesting. It is not a nearest-neighbor lookup. It is a stateful, iterative playlist builder.

### Building the Query Vector

The engine starts by constructing a query vector that represents the desired vibe. It blends two sources:

1. **Seed tracks**: The immediate context. If you start with Billie Eilish's *ocean eyes*, The xx's *On Hold*, and Flume's *Bring You Down*, their embeddings are averaged and normalized into a seed vector.
2. **Liked profile**: A cached centroid of every track in the user's liked-songs table, refreshed every five minutes.

The final query vector is a weighted blend of the two, heavily biased toward the seed context. This prevents the playlist from drifting too far from long-term taste while staying responsive to what you asked for right now.

### Candidate Pool and ANN

With the query vector in hand, the engine queries the database for the top candidates by cosine similarity, filtered by an optional cluster whitelist and a similarity floor. Tracks below the floor are discarded — they are too far from the requested vibe to be useful.

The pool is pre-filtered against skipped artists and tracks. Skips are first-class behavioral data. If you hit skip on a track, it is dead to the engine. Same for artist-level skips. The candidate ranking injects microscopic jitter to break ties and prevent the same playlist from regenerating identically every time.

### MMR Selection with Artist Constraints

The core loop implements Maximal Marginal Relevance (MMR), optimized to linear complexity per selection instead of quadratic.

For each slot in the playlist:

- **Relevance** is the cosine similarity between the candidate and the query vector.
- **Diversity** is the maximum similarity the candidate has to any already-selected track. This is maintained incrementally: after each selection, the system updates a running maximum for every remaining candidate by comparing against the newly chosen track. No recomputation from scratch.
- The MMR score weights relevance heavily over diversity. The balance is tuned so relevance dominates, but diversity still suppresses sonic clones.

On top of MMR, a soft artist penalty applies. A global counter tracks how many times an artist has appeared. A streak counter penalizes consecutive tracks sharing an artist beyond a tight limit. A hard cap prevents any single artist from monopolizing the playlist.

Selection uses softmax sampling with an aggressive temperature. The distribution is sharp: the engine almost always picks the top MMR candidate, but occasionally grabs the second or third for serendipity. Numerical stability is handled by subtracting the max score before exponentiation.

### Query Drift

After each selection, the query vector evolves. It slowly absorbs the character of the track it just picked, weighted heavily toward its previous state. The playlist starts where you asked, then gently glides toward whatever local sub-vibe emerged from the early selections.

A small noise term prevents the query from collapsing into a pure centroid of the already-selected tracks. The result is a playlist that feels coherent but not static: a seed might begin in "Atmospheric Hip-Hop" and drift toward "Ethereal Pop" without jarring transitions. It breathes. Playlists that strictly follow a seed become monotonous after ten tracks. Playlists that randomize lose identity. Query drift gives the best of both.

## The Server and Home Assistant Integration

A lightweight HTTP server sits between the recommendation layer and the house. It is triggered externally — typically by a Home Assistant automation or a scheduled cron job — and returns immediately after queuing playback.

The primary endpoint takes a pre-computed playlist and fires a webhook to Home Assistant. Home Assistant relays the track URIs to Music Assistant via its own API. The server then pre-computes the *next* playlist asynchronously, so there is always a warm buffer waiting. No cold starts.

There is also a time-aware vibe endpoint. It maintains a mapping of cluster families to hours of day. Morning pulls from "Emotional Ballads & Indie Folk" and "Uplifting Pop-Rock." Evening shifts toward "Modern Pop & Chill Trap-Pop." Night drifts into "Symphonic Pop & Dramatic Ballads." It samples random liked tracks from the current temporal family as seeds, runs the engine with those cluster IDs locked, and sends the result to the speakers. The house knows what time it is.

A debug dashboard exposes the current track, cluster assignments, an interactive cluster explorer, manual seed search, and queue preview. Clicking a cluster generates a 30-song playlist from that vibe in real time. This is useful for validating that cluster 34 ("Deep House & Groovy Club Beats") actually sounds like deep house, not a mislabeled folk cluster.

## Why This Works

Text-based recommendation — using artist names, genres, or LLM descriptions — collapses tracks into categories humans invented. Audio embeddings collapse them into categories the model learned from sound itself. K-Means then surfaces the natural boundaries in that latent space. The engine does not search for "similar tags"; it searches for similar *perception*.

The drift mechanism is the part I am most happy with. It is the difference between a playlist that feels robotic and one that feels alive. MMR keeps diversity in check. Artist penalties prevent repetition. Drift lets the playlist evolve. Together they produce something that sounds like a DJ with good taste and a short attention span.

Current stats: ~100k tracks indexed, 60 clusters, 512-dimensional embeddings, ~80ms to build a 60-song playlist on a local Postgres instance. The system runs headless. I trigger it from a Home Assistant button. Music starts. I do not touch it again.
