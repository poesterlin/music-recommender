use std::path::Path;

use anyhow::{bail, Result};

use crate::embed::FrameEmbedder;
use crate::model::OnnxEmbeddingModel;
#[cfg(feature = "onnxruntime")]
use crate::OrtEmbeddingModel;

pub enum InferenceModel {
    Tract(OnnxEmbeddingModel),
    #[cfg(feature = "onnxruntime")]
    Ort(OrtEmbeddingModel),
}

impl FrameEmbedder for InferenceModel {
    fn embed_frontend_frame(&self, frontend_frame: &[f32]) -> Result<Vec<f32>> {
        match self {
            Self::Tract(model) => model.embed_frontend_frame(frontend_frame),
            #[cfg(feature = "onnxruntime")]
            Self::Ort(model) => model.embed_frontend_frame(frontend_frame),
        }
    }
}

pub fn load_embedding_model(
    backend: &str,
    model_path: &Path,
    metadata_path: &Path,
) -> Result<InferenceModel> {
    match backend.to_ascii_lowercase().as_str() {
        "tract" => Ok(InferenceModel::Tract(OnnxEmbeddingModel::load_verified(
            model_path,
            metadata_path,
        )?)),
        #[cfg(feature = "onnxruntime")]
        "ort" => Ok(InferenceModel::Ort(OrtEmbeddingModel::load_verified(
            model_path,
            metadata_path,
        )?)),
        #[cfg(not(feature = "onnxruntime"))]
        "ort" => bail!("the onnxruntime feature is not enabled in this build"),
        other => bail!("unknown inference backend {other:?}; expected tract or ort"),
    }
}
