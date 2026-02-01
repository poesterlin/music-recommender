# Music Recommender Notes

## Library Indexing
- Replaced the original `music_assistant/search` call with paginated `get_library` queries (limit 500, offset loop). This avoids loading the entire track list at once.
- Tracks are fetched in batches and written in chunks (150 records) to the local DB, keeping the library synchronized without blowing up memory.
- The response now contains the stable `library://` URIs, which match the rest of the recommendation pipeline.

## Herbert Grönemeyer Observations
- His albums (e.g., *Mensch*, *4630 Bochum*) appear in the library, but not all tracks were marked as `library` until explicitly indexed.
- Using direct track searches (`search` endpoint) for specific names (e.g., “Der Weg”) returns Plex-specific URIs, but searching by artist name didn’t consistently surface results due to encoding or provider filtering.
- Newly added tracks are still returned with their provider URIs (like `plex--WBNqQe7f://...`), so embedding lookups should keep working.

## Adding Library Items
- The server exposes `music/library/add_item`, which expects the full MediaItem payload (the same object the UI sends over WebSocket).
- To bulk-add Plex tracks, replicate that object structure (item + metadata + provider mappings) and POST it to `/api/services/music_assistant/library/add_item?return_response`.
- Once added, the library entry references the same provider URI; the library wrapper (`library://track/...`) sits alongside it.

## Playability & Cleanup
- Plex URIs can still be played via the `play_media` service, so removing Plex-only entries without embeddings (which was already done) doesn’t break playback for tracks that remain.
- Plex tracks without embeddings were deleted from the DB so the indexer and embedding job only see the library-level URIs that are properly embedded or queued.

## Next Steps (Optional)
- Consider scripting the discovery of missing tracks (e.g., via provider APIs or manual metadata exports) and feeding structured `library/add_item` payloads to ensure all artist/album tracks appear in the library.
- Monitor the embedding queue after running the indexer to confirm new entries progress through the recommendation pipeline.
