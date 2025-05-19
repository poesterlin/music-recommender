



type LibraryResponse = {
    service_response: ServiceResponse;
  };
  
  interface ServiceResponse {
    artists: Artist[];
    albums: Album[];
    tracks: Track[];
    playlists: Playlist[];
    radio: Radio[];
    audiobooks: any[];
    podcasts: any[];
  }
  
  interface Artist {
    media_type: string;
    uri: string;
    name: string;
    version: string;
    image?: string;
  }
  
  interface Album {
    media_type: string;
    uri: string;
    name: string;
    version: string;
    image: string;
    artists: Artist[];
  }
  
  interface Track {
    media_type: string;
    uri: string;
    name: string;
    version: string;
    image: string;
    artists: Artist[];
    album: Album;
  }
  
  interface Playlist {
    media_type: string;
    uri: string;
    name: string;
    version: string;
    image?: string;
  }
  
  interface Radio {
    media_type: string;
    uri: string;
    name: string;
    version: string;
    image: string;
  }


  /**
 * The main structure of the API response.
 */
interface QueueApiResponse {
  changed_states: unknown[]; // Use 'unknown' for type safety if structure isn't defined
  service_response: ServiceResponseData;
}

/**
 * Represents the `service_response` object, which contains data for one or more media players.
 * The keys are dynamic player IDs (e.g., "media_player.smart_amp_5_19677_2").
 */
interface ServiceResponseData {
  [playerId: string]: MediaPlayerQueue;
}

/**
 * Describes the state of a single media player's queue.
 */
interface MediaPlayerQueue {
  queue_id: string;
  active: boolean;
  name: string; // Name of the media player (e.g., "Verstärker")
  items: number; // Total number of items in the queue
  shuffle_enabled: boolean;
  repeat_mode: string; // e.g., "off", "one", "all"
  current_index: number;
  elapsed_time: number;
  current_item: QueueTrackItem;
  next_item: QueueTrackItem | null; // Can be null if there's no next item
}

/**
 * Represents an item in the media player's queue.
 */
interface QueueTrackItem {
  queue_item_id: string;
  name: string; // Display name for the queue item (e.g., "Ava Max - So Am I")
  duration: number; // Duration in seconds
  media_item: TrackMediaInfo; // The actual media content (seems to be a track)
  stream_title: string | null;
  stream_details?: StreamDetails; // Optional, as it might not be present for all items (e.g., next_item)
}

/**
 * Details about the media stream.
 */
interface StreamDetails {
  content_type: string; // e.g., "mp3"
  sample_rate: number;
  bit_depth: number;
  provider: string;
  item_id: string;
}

/**
 * Base attributes common to various media types (artist, album, track).
 */
interface BaseMediaAttributes {
  uri: string;
  name: string;
  version: string;
}

/**
 * Information about an artist.
 */
interface ArtistMediaInfo extends BaseMediaAttributes {
  media_type: "artist";
  image: string | null; // URL to the artist's image, or null
}

/**
 * Information about an album.
 */
interface AlbumMediaInfo extends BaseMediaAttributes {
  media_type: "album";
  image: string; // URL to the album's image (seems to be always present)
  artists: ArtistMediaInfo[]; // Artists credited on the album
}

/**
 * Information about a track.
 */
interface TrackMediaInfo extends BaseMediaAttributes {
  media_type: "track";
  image: string; // URL to the track's image (often album art, seems always present)
  artists: ArtistMediaInfo[]; // Artists performing the track
  album: AlbumMediaInfo; // The album this track belongs to
}

