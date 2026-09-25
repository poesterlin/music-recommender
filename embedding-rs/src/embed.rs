use anyhow::{anyhow, Result};

use crate::framing::{center_and_pad, frame_at, frame_count};
use crate::model::OnnxEmbeddingModel;
use crate::EMBEDDING_SIZE;

pub trait Frontend {
    /// Convert one 48 kHz, 48,000-sample frame to `[256, 199, 1]`
    /// row-major data.
    fn mel256(&self, audio_frame: &[f32]) -> Result<Vec<f32>>;
}

const INFERENCE_BATCH_SIZE: usize = 1;

pub trait FrameEmbedder {
    fn embed_frontend_frame(&self, frontend_frame: &[f32]) -> Result<Vec<f32>>;

    fn embed_frontend_batch(&self, frontend_frames: &[Vec<f32>]) -> Result<Vec<Vec<f32>>> {
        frontend_frames
            .iter()
            .map(|frame| self.embed_frontend_frame(frame))
            .collect()
    }
}

impl FrameEmbedder for OnnxEmbeddingModel {
    fn embed_frontend_frame(&self, frontend_frame: &[f32]) -> Result<Vec<f32>> {
        self.run_frame(frontend_frame)
    }

    fn embed_frontend_batch(&self, frontend_frames: &[Vec<f32>]) -> Result<Vec<Vec<f32>>> {
        self.run_batch(frontend_frames)
    }
}

#[cfg(feature = "onnxruntime")]
impl FrameEmbedder for crate::OrtEmbeddingModel {
    fn embed_frontend_frame(&self, frontend_frame: &[f32]) -> Result<Vec<f32>> {
        self.run_frame(frontend_frame)
    }
}

/// Run the OpenL3 frame model and mean-pool its outputs, matching the
/// production worker's `np.mean(emb, axis=0)` operation.
pub fn embed_audio<E: FrameEmbedder, F: Frontend>(
    samples: &[f32],
    frontend: &F,
    embedder: &E,
) -> Result<Vec<f32>> {
    if samples.is_empty() {
        return Err(anyhow!("cannot embed empty audio"));
    }
    let padded = center_and_pad(samples);
    let count = frame_count(samples);
    let mut sum = vec![0.0_f32; EMBEDDING_SIZE];
    let mut actual_frames = 0_usize;
    let mut frontend_batch = Vec::with_capacity(INFERENCE_BATCH_SIZE);

    for index in 0..count {
        let frontend_frame = frontend.mel256(frame_at(&padded, index))?;
        if frontend_frame.len() != 256 * 199 {
            return Err(anyhow!(
                "frontend frame {} has {} values; expected {}",
                index,
                frontend_frame.len(),
                256 * 199
            ));
        }
        frontend_batch.push(frontend_frame);
        if frontend_batch.len() == INFERENCE_BATCH_SIZE {
            actual_frames += add_embedding_batch(&mut sum, &frontend_batch, embedder)?;
            frontend_batch.clear();
        }
    }
    if !frontend_batch.is_empty() {
        actual_frames += add_embedding_batch(&mut sum, &frontend_batch, embedder)?;
    }

    if actual_frames == 0 {
        return Err(anyhow!("no OpenL3 frames were produced"));
    }
    let inverse = 1.0 / actual_frames as f32;
    for value in &mut sum {
        *value *= inverse;
        if !value.is_finite() {
            return Err(anyhow!("mean embedding contains a non-finite value"));
        }
    }
    Ok(sum)
}

fn add_embedding_batch<E: FrameEmbedder>(
    sum: &mut [f32],
    frontend_batch: &[Vec<f32>],
    embedder: &E,
) -> Result<usize> {
    let values = embedder.embed_frontend_batch(frontend_batch)?;
    if values.len() != frontend_batch.len() {
        return Err(anyhow!(
            "model returned {} frame embeddings; expected {}",
            values.len(),
            frontend_batch.len()
        ));
    }
    for (batch_index, values) in values.into_iter().enumerate() {
        if values.len() != EMBEDDING_SIZE {
            return Err(anyhow!(
                "model frame {} has {} values; expected {}",
                batch_index,
                values.len(),
                EMBEDDING_SIZE
            ));
        }
        for (total, value) in sum.iter_mut().zip(values) {
            *total += value;
        }
    }
    Ok(frontend_batch.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeFrontend;
    impl Frontend for FakeFrontend {
        fn mel256(&self, _audio_frame: &[f32]) -> Result<Vec<f32>> {
            Ok(vec![0.0; 256 * 199])
        }
    }

    struct FakeEmbedder;
    impl FrameEmbedder for FakeEmbedder {
        fn embed_frontend_frame(&self, _input: &[f32]) -> Result<Vec<f32>> {
            Ok(vec![2.0; EMBEDDING_SIZE])
        }
    }

    #[test]
    fn mean_pools_all_frames() {
        let samples = vec![0.0; crate::FRAME_SIZE * 2];
        let result = embed_audio(&samples, &FakeFrontend, &FakeEmbedder).unwrap();
        assert_eq!(result, vec![2.0; EMBEDDING_SIZE]);
    }
}
