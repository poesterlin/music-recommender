use std::cell::RefCell;
use std::fmt::Write as _;
use std::fs;
use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tract_onnx::prelude::*;

use crate::EMBEDDING_SIZE;

const MODEL_MEL_BINS: usize = 256;
const MODEL_FRAMES: usize = 199;
const MODEL_INPUT_SIZE: usize = MODEL_MEL_BINS * MODEL_FRAMES;
const MODEL_BATCH_SIZE: usize = 1;

#[derive(Debug, Deserialize)]
struct ModelMetadata {
    model: String,
    onnx_sha256: String,
    opset: i64,
    input_shape: Vec<Option<i64>>,
    output_shape: Vec<Option<i64>>,
}

/// A loaded frontend-free OpenL3 network.
///
/// The callable is kept behind a small closure so callers do not depend on
/// tract's internal `SimplePlan` type aliases. The model is loaded and
/// optimized once, then reused for every one-second frame.
type BatchRunner = Box<dyn Fn(&[f32], usize) -> Result<Vec<Vec<f32>>>>;

pub struct OnnxEmbeddingModel {
    run_batch: BatchRunner,
}

impl OnnxEmbeddingModel {
    /// Load an ONNX file only when its pinned metadata matches the bytes on
    /// disk. The metadata check is deliberately separate from `load` so
    /// callers can choose the strict production path explicitly.
    pub fn load_verified(
        model_path: impl AsRef<Path>,
        metadata_path: impl AsRef<Path>,
    ) -> Result<Self> {
        verify_model_artifact(model_path.as_ref(), metadata_path.as_ref())?;
        Self::load(model_path)
    }

    pub fn load(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let model = tract_onnx::onnx()
            .model_for_path(path)
            .with_context(|| format!("load ONNX model {}", path.display()))?
            .with_input_fact(
                0,
                InferenceFact::dt_shape(
                    f32::datum_type(),
                    tvec!(MODEL_BATCH_SIZE, MODEL_MEL_BINS, MODEL_FRAMES, 1),
                ),
            )
            .with_context(|| format!("set model input fact for {}", path.display()))?
            .into_optimized()
            .with_context(|| format!("optimize ONNX model {}", path.display()))?
            .into_runnable()
            .with_context(|| format!("plan ONNX model {}", path.display()))?;

        let executor = tract_linalg::multithread::Executor::multithread(configured_thread_count());
        // Reuse tract's activation/state buffers across one-second frames.
        let state =
            RefCell::new(SimpleState::new(model.clone()).context("create OpenL3 execution state")?);
        let run_batch = Box::new(
            move |input: &[f32], batch_size: usize| -> Result<Vec<Vec<f32>>> {
                if batch_size == 0
                    || batch_size > MODEL_BATCH_SIZE
                    || input.len() != batch_size * MODEL_INPUT_SIZE
                {
                    return Err(anyhow!(
                        "model input has {} values; expected 1..={} frames",
                        input.len(),
                        MODEL_BATCH_SIZE
                    ));
                }
                let tensor = if batch_size == MODEL_BATCH_SIZE {
                    Tensor::from_shape(&[MODEL_BATCH_SIZE, MODEL_MEL_BINS, MODEL_FRAMES, 1], input)
                } else {
                    let mut padded = vec![0.0_f32; MODEL_BATCH_SIZE * MODEL_INPUT_SIZE];
                    padded[..input.len()].copy_from_slice(input);
                    Tensor::from_shape(
                        &[MODEL_BATCH_SIZE, MODEL_MEL_BINS, MODEL_FRAMES, 1],
                        &padded,
                    )
                }
                .context("create OpenL3 input tensor")?;
                let outputs =
                    tract_linalg::multithread::multithread_tract_scope(executor.clone(), || {
                        state.borrow_mut().run(tvec!(tensor.into_tvalue()))
                    })
                    .context("run OpenL3 network")?;
                let output = outputs
                    .first()
                    .ok_or_else(|| anyhow!("OpenL3 network returned no output"))?;
                let values = output
                    .to_array_view::<f32>()
                    .context("read OpenL3 output tensor")?
                    .iter()
                    .copied()
                    .collect::<Vec<_>>();
                if values.len() != MODEL_BATCH_SIZE * EMBEDDING_SIZE {
                    return Err(anyhow!(
                        "OpenL3 network returned {} values; expected {}",
                        values.len(),
                        MODEL_BATCH_SIZE * EMBEDDING_SIZE
                    ));
                }
                if values.iter().any(|value| !value.is_finite()) {
                    return Err(anyhow!("OpenL3 network returned a non-finite value"));
                }
                Ok(values
                    .chunks_exact(EMBEDDING_SIZE)
                    .take(batch_size)
                    .map(<[f32]>::to_vec)
                    .collect())
            },
        );

        Ok(Self { run_batch })
    }

    pub fn run_frame(&self, frontend_frame: &[f32]) -> Result<Vec<f32>> {
        let mut values = (self.run_batch)(frontend_frame, 1)?;
        values
            .pop()
            .ok_or_else(|| anyhow!("OpenL3 network returned no frame"))
    }

    pub fn run_batch(&self, frontend_frames: &[Vec<f32>]) -> Result<Vec<Vec<f32>>> {
        if frontend_frames.is_empty() {
            return Ok(Vec::new());
        }
        let flat = frontend_frames
            .iter()
            .flat_map(|frame| frame.iter().copied())
            .collect::<Vec<_>>();
        (self.run_batch)(&flat, frontend_frames.len())
    }
}

pub(crate) fn verify_model_artifact(model_path: &Path, metadata_path: &Path) -> Result<()> {
    let bytes = fs::read(model_path)
        .with_context(|| format!("read model artifact {}", model_path.display()))?;
    let digest = hex_digest(&bytes);
    let metadata: ModelMetadata = serde_json::from_slice(
        &fs::read(metadata_path)
            .with_context(|| format!("read model metadata {}", metadata_path.display()))?,
    )
    .with_context(|| format!("parse model metadata {}", metadata_path.display()))?;

    if metadata.model != "openl3_audio_mel256_music" {
        bail!("unexpected model metadata: {}", metadata.model);
    }
    if metadata.opset != 13 {
        bail!("unsupported ONNX opset {}; expected 13", metadata.opset);
    }
    if metadata.input_shape != vec![None, Some(256), Some(199), Some(1)]
        || metadata.output_shape != vec![None, Some(512)]
    {
        bail!(
            "unexpected model shapes: input {:?}, output {:?}",
            metadata.input_shape,
            metadata.output_shape
        );
    }
    if metadata.onnx_sha256 != digest {
        bail!(
            "model SHA-256 mismatch: expected {}, got {}",
            metadata.onnx_sha256,
            digest
        );
    }
    Ok(())
}

pub(crate) fn configured_thread_count() -> usize {
    let default_threads = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(1)
        .min(8);
    std::env::var("MUSIC_EMBEDDING_THREADS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default_threads)
        .min(32)
}

fn hex_digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut output, "{byte:02x}").expect("writing to a String cannot fail");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_size_is_stable() {
        assert_eq!(MODEL_INPUT_SIZE, 50_944);
    }
}
