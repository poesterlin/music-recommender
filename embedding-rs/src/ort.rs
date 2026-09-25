use std::path::Path;

use anyhow::{anyhow, Context, Result};
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;

use crate::model::{configured_thread_count, verify_model_artifact};
use crate::EMBEDDING_SIZE;

const INPUT_SHAPE: [usize; 4] = [1, 256, 199, 1];

/// ONNX Runtime backend for the frontend-free OpenL3 network.
pub struct OrtEmbeddingModel {
    session: Session,
}

impl OrtEmbeddingModel {
    pub fn load_verified(
        model_path: impl AsRef<Path>,
        metadata_path: impl AsRef<Path>,
    ) -> Result<Self> {
        verify_model_artifact(model_path.as_ref(), metadata_path.as_ref())?;
        Self::load(model_path)
    }

    pub fn load(model_path: impl AsRef<Path>) -> Result<Self> {
        let model_path = model_path.as_ref();
        let session = Session::builder()?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_intra_threads(configured_thread_count())?
            .with_inter_threads(1)?
            .commit_from_file(model_path)
            .with_context(|| format!("load ONNX Runtime model {}", model_path.display()))?;
        Ok(Self { session })
    }

    pub fn run_frame(&self, frontend_frame: &[f32]) -> Result<Vec<f32>> {
        let input = Tensor::from_array((INPUT_SHAPE, frontend_frame.to_vec()))
            .context("create ONNX Runtime input tensor")?;
        let inputs = ort::inputs![input]?;
        let outputs = self
            .session
            .run(inputs)
            .context("run ONNX Runtime network")?;
        let (_shape, values) = outputs[0]
            .try_extract_raw_tensor::<f32>()
            .context("read ONNX Runtime output tensor")?;
        if values.len() != EMBEDDING_SIZE {
            return Err(anyhow!(
                "ONNX Runtime returned {} values; expected {}",
                values.len(),
                EMBEDDING_SIZE
            ));
        }
        if values.iter().any(|value| !value.is_finite()) {
            return Err(anyhow!("ONNX Runtime returned a non-finite value"));
        }
        Ok(values.to_vec())
    }
}
