//! Pure-Rust OpenL3-compatible embedding primitives.
//!
//! The numerical/audio core is kept independent from the database worker so
//! it can be tested with local fixtures and reused by a future WASM adapter.

mod audio;
mod backend;
#[cfg(feature = "cli")]
mod db;
mod embed;
mod file_index;
mod framing;
mod frontend;
mod metrics;
mod model;
#[cfg(feature = "onnxruntime")]
mod ort;
mod resample;
#[cfg(feature = "cli")]
mod worker;

pub use audio::{decode_mono, DecodedAudio};
pub use backend::{load_embedding_model, InferenceModel};
#[cfg(feature = "cli")]
pub use db::{
    connect, fetch_unembedded_page, preflight, EmbeddingSpaceInfo, TrackRow, EXPECTED_MODEL,
    EXPECTED_VERSION,
};
pub use embed::{embed_audio, FrameEmbedder, Frontend};
pub use file_index::{build_audio_index, AudioFileIndex, TrackMetadata};
pub use framing::{center_and_pad, frame_at, frame_count};
pub use frontend::KapreFrontend;
pub use metrics::{compare_vectors, VectorMetrics};
pub use model::OnnxEmbeddingModel;
#[cfg(feature = "onnxruntime")]
pub use ort::OrtEmbeddingModel;
pub use resample::resample_to_target;
#[cfg(feature = "cli")]
pub use worker::{run as run_worker, WorkerArgs};

pub const EMBEDDING_SIZE: usize = 512;
pub const TARGET_SAMPLE_RATE: u32 = 48_000;
pub const FRAME_SIZE: usize = TARGET_SAMPLE_RATE as usize;
pub const HOP_SIZE: usize = 4_800;
