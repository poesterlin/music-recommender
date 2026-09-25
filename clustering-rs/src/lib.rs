//! Fast, deterministic clustering primitives for the music recommender.
//!
//! The database/CLI layer lives in `main.rs`.  This module deliberately has
//! no database or native runtime dependencies, so the same core can be reused
//! from a future WASM build.

use rand::seq::SliceRandom;
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde::Serialize;
use std::collections::HashMap;

#[cfg(feature = "rayon")]
use rayon::prelude::*;

const DEFAULT_TOLERANCE: f32 = 0.0001;
const DEFAULT_PCA_ITERATIONS: usize = 10;
const DEFAULT_PCA_SAMPLE_SIZE: usize = 5_000;
const DEFAULT_METRIC_SAMPLE_SIZE: usize = 1_500;

/// One track and its already-centered embedding.
#[derive(Clone, Debug)]
pub struct TrackEmbedding {
    pub uri: String,
    pub name: String,
    pub cluster_id: Option<i32>,
    pub embedding: Vec<f32>,
}

/// A collection of tracks with one common embedding dimension.
#[derive(Clone, Debug)]
pub struct Dataset {
    pub tracks: Vec<TrackEmbedding>,
}

impl Dataset {
    pub fn dimensions(&self) -> Result<usize, String> {
        let first = self
            .tracks
            .first()
            .map(|track| track.embedding.len())
            .ok_or_else(|| "dataset is empty".to_string())?;
        if self
            .tracks
            .iter()
            .any(|track| track.embedding.len() != first)
        {
            return Err("all embeddings must have the same dimension".to_string());
        }
        Ok(first)
    }

    /// Deterministically take at most `limit` tracks for a quick benchmark.
    pub fn sample(&self, limit: usize, seed: u64) -> Dataset {
        if limit == 0 || limit >= self.tracks.len() {
            return self.clone();
        }

        let mut indices: Vec<usize> = (0..self.tracks.len()).collect();
        let mut rng = ChaCha8Rng::seed_from_u64(seed);
        indices.shuffle(&mut rng);
        indices.truncate(limit);
        indices.sort_unstable();

        Dataset {
            tracks: indices
                .into_iter()
                .map(|index| self.tracks[index].clone())
                .collect(),
        }
    }
}

/// Dense row-major matrix used by the numerical core.
#[derive(Clone, Debug)]
pub struct Matrix {
    rows: usize,
    cols: usize,
    data: Vec<f32>,
}

impl Matrix {
    pub fn from_rows(rows: Vec<Vec<f32>>) -> Result<Self, String> {
        let row_count = rows.len();
        let col_count = rows.first().map(Vec::len).unwrap_or(0);
        if row_count == 0 || col_count == 0 {
            return Err("matrix must not be empty".to_string());
        }
        if rows.iter().any(|row| row.len() != col_count) {
            return Err("matrix rows must all have the same length".to_string());
        }

        let data = rows.into_iter().flatten().collect();
        Ok(Self {
            rows: row_count,
            cols: col_count,
            data,
        })
    }

    pub fn rows(&self) -> usize {
        self.rows
    }

    pub fn cols(&self) -> usize {
        self.cols
    }

    pub fn row(&self, index: usize) -> &[f32] {
        let start = index * self.cols;
        &self.data[start..start + self.cols]
    }
}

fn select_rows(matrix: &Matrix, indices: &[usize]) -> Matrix {
    let mut data = Vec::with_capacity(indices.len() * matrix.cols);
    for &index in indices {
        data.extend_from_slice(matrix.row(index));
    }
    Matrix {
        rows: indices.len(),
        cols: matrix.cols,
        data,
    }
}

/// Options for the standalone benchmark.
#[derive(Clone, Debug, Serialize)]
pub struct BenchmarkConfig {
    pub k: usize,
    pub pca_dimensions: usize,
    pub evaluation_dimensions: usize,
    pub pca_iterations: usize,
    pub pca_sample_size: usize,
    pub runs: usize,
    pub max_iterations: usize,
    pub tolerance: f32,
    pub seed: u64,
    pub metric_sample_size: usize,
}

impl Default for BenchmarkConfig {
    fn default() -> Self {
        Self {
            k: 50,
            pca_dimensions: 32,
            evaluation_dimensions: 32,
            pca_iterations: DEFAULT_PCA_ITERATIONS,
            pca_sample_size: DEFAULT_PCA_SAMPLE_SIZE,
            runs: 3,
            max_iterations: 100,
            tolerance: DEFAULT_TOLERANCE,
            seed: 42,
            metric_sample_size: DEFAULT_METRIC_SAMPLE_SIZE,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct PcaInfo {
    pub applied: bool,
    pub input_dimensions: usize,
    pub output_dimensions: usize,
    pub sample_size: usize,
    pub iterations: usize,
    pub explained_variance_ratio: Vec<f64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct QualityMetrics {
    pub cluster_count: usize,
    pub min_cluster_size: usize,
    pub max_cluster_size: usize,
    pub mean_cluster_size: f64,
    pub mean_intra_similarity: f64,
    pub inertia: f64,
    pub silhouette: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct RunReport {
    pub seed: u64,
    pub iterations: usize,
    pub converged: bool,
    pub training_inertia: f64,
    pub metrics: QualityMetrics,
    pub adjusted_rand_index_vs_current: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct BenchmarkReport {
    pub config: BenchmarkConfig,
    pub track_count: usize,
    pub dimensions: usize,
    pub pca: PcaInfo,
    pub evaluation_pca: PcaInfo,
    pub current_assignments: Option<QualityMetrics>,
    pub mean_pairwise_ari: Option<f64>,
    pub min_pairwise_ari: Option<f64>,
    pub runs: Vec<RunReport>,
    pub best_run: usize,
}

#[derive(Clone, Debug)]
pub struct RunResult {
    pub seed: u64,
    pub labels: Vec<usize>,
    pub centroids: Vec<Vec<f32>>,
    pub iterations: usize,
    pub converged: bool,
    pub training_inertia: f64,
    pub metrics: QualityMetrics,
    pub adjusted_rand_index_vs_current: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct BenchmarkResult {
    pub config: BenchmarkConfig,
    pub pca: PcaInfo,
    pub evaluation_pca: PcaInfo,
    pub current_assignments: Option<QualityMetrics>,
    pub runs: Vec<RunResult>,
    pub best_run: usize,
}

impl BenchmarkResult {
    pub fn report(&self) -> BenchmarkReport {
        let mut pairwise_ari = Vec::new();
        for left_index in 0..self.runs.len() {
            for right_index in (left_index + 1)..self.runs.len() {
                let right_labels: Vec<Option<usize>> = self.runs[right_index]
                    .labels
                    .iter()
                    .copied()
                    .map(Some)
                    .collect();
                if let Some(score) =
                    adjusted_rand_index(&self.runs[left_index].labels, &right_labels)
                {
                    pairwise_ari.push(score);
                }
            }
        }
        let mean_pairwise_ari = if pairwise_ari.is_empty() {
            None
        } else {
            Some(pairwise_ari.iter().sum::<f64>() / pairwise_ari.len() as f64)
        };
        let min_pairwise_ari = pairwise_ari.iter().copied().reduce(f64::min);

        BenchmarkReport {
            config: self.config.clone(),
            track_count: self.runs.first().map(|run| run.labels.len()).unwrap_or(0),
            dimensions: self.pca.input_dimensions,
            pca: self.pca.clone(),
            evaluation_pca: self.evaluation_pca.clone(),
            current_assignments: self.current_assignments.clone(),
            mean_pairwise_ari,
            min_pairwise_ari,
            runs: self
                .runs
                .iter()
                .map(|run| RunReport {
                    seed: run.seed,
                    iterations: run.iterations,
                    converged: run.converged,
                    training_inertia: run.training_inertia,
                    metrics: run.metrics.clone(),
                    adjusted_rand_index_vs_current: run.adjusted_rand_index_vs_current,
                })
                .collect(),
            best_run: self.best_run,
        }
    }
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    a.iter().zip(b).map(|(left, right)| left * right).sum()
}

fn norm(values: &[f32]) -> f32 {
    dot(values, values).sqrt()
}

fn normalize(values: &mut [f32]) {
    let magnitude = norm(values);
    if magnitude > f32::EPSILON {
        for value in values {
            *value /= magnitude;
        }
    }
}

fn normalize_rows(matrix: &mut Matrix) {
    for index in 0..matrix.rows {
        let start = index * matrix.cols;
        normalize(&mut matrix.data[start..start + matrix.cols]);
    }
}

fn sample_indices(length: usize, limit: usize, seed: u64) -> Vec<usize> {
    if limit == 0 || limit >= length {
        return (0..length).collect();
    }

    let mut indices: Vec<usize> = (0..length).collect();
    let mut rng = ChaCha8Rng::seed_from_u64(seed);
    indices.shuffle(&mut rng);
    indices.truncate(limit);
    indices.sort_unstable();
    indices
}

fn validate_finite(values: &[f32], label: &str) -> Result<(), String> {
    if values.iter().all(|value| value.is_finite()) {
        Ok(())
    } else {
        Err(format!("{label} contains a non-finite value"))
    }
}

fn matrix_from_dataset(dataset: &Dataset) -> Result<Matrix, String> {
    let rows = dataset
        .tracks
        .iter()
        .map(|track| {
            validate_finite(&track.embedding, "embedding")?;
            Ok(track.embedding.clone())
        })
        .collect::<Result<Vec<_>, String>>()?;
    Matrix::from_rows(rows)
}

fn deterministic_start(component: usize, dimensions: usize) -> Vec<f32> {
    (0..dimensions)
        .map(|index| {
            ((component + 1) as f32 * (index + 1) as f32 * 12.9898).sin()
                + ((index + 1) as f32 * 0.37).cos()
        })
        .collect()
}

fn pca_projection(
    dataset: &Dataset,
    dimensions: usize,
    pca_dimensions: usize,
    pca_iterations: usize,
    pca_sample_size: usize,
    seed: u64,
) -> Result<(Matrix, PcaInfo), String> {
    if pca_dimensions == 0 || pca_dimensions >= dimensions {
        let mut features = matrix_from_dataset(dataset)?;
        normalize_rows(&mut features);
        let output_dimensions = features.cols();
        return Ok((
            features,
            PcaInfo {
                applied: false,
                input_dimensions: dimensions,
                output_dimensions,
                sample_size: dataset.tracks.len(),
                iterations: 0,
                explained_variance_ratio: vec![],
            },
        ));
    }

    let track_count = dataset.tracks.len();
    let sample_count = pca_sample_size.min(track_count).max(1);
    let sample_indices = sample_indices(track_count, sample_count, seed);
    let mut mean = vec![0f64; dimensions];
    for track in &dataset.tracks {
        for (dimension, value) in mean.iter_mut().enumerate() {
            *value += track.embedding[dimension] as f64;
        }
    }
    for value in &mut mean {
        *value /= track_count as f64;
    }

    let mut centered_sample = Matrix {
        rows: sample_indices.len(),
        cols: dimensions,
        data: vec![0.0; sample_indices.len() * dimensions],
    };
    for (sample_index, track_index) in sample_indices.iter().enumerate() {
        let start = sample_index * dimensions;
        for (dimension, mean_value) in mean.iter().enumerate() {
            centered_sample.data[start + dimension] =
                dataset.tracks[*track_index].embedding[dimension] - *mean_value as f32;
        }
    }

    let mut total_variance = 0.0f64;
    for value in &centered_sample.data {
        total_variance += (*value as f64) * (*value as f64);
    }
    total_variance /= centered_sample.rows as f64;

    let mut components: Vec<Vec<f32>> = Vec::with_capacity(pca_dimensions);
    let mut explained_variance_ratio = Vec::with_capacity(pca_dimensions);

    for component_index in 0..pca_dimensions {
        let mut vector = deterministic_start(component_index, dimensions);
        normalize(&mut vector);

        for _ in 0..pca_iterations {
            let scores: Vec<f32> = (0..centered_sample.rows)
                .map(|row| dot(centered_sample.row(row), &vector))
                .collect();
            let mut next = vec![0.0f32; dimensions];
            for (row, &score) in scores.iter().enumerate() {
                let weight = score / centered_sample.rows as f32;
                let offset = row * dimensions;
                for (dimension, next_value) in next.iter_mut().enumerate() {
                    *next_value += centered_sample.data[offset + dimension] * weight;
                }
            }

            for previous in &components {
                let projection = dot(&next, previous);
                for dimension in 0..dimensions {
                    next[dimension] -= projection * previous[dimension];
                }
            }
            normalize(&mut next);
            let delta = next
                .iter()
                .zip(&vector)
                .map(|(left, right)| (left - right).abs())
                .sum::<f32>();
            vector = next;
            if delta < 1e-6 {
                break;
            }
        }

        let scores: Vec<f32> = (0..centered_sample.rows)
            .map(|row| dot(centered_sample.row(row), &vector))
            .collect();
        let variance = scores
            .iter()
            .map(|score| (*score as f64) * (*score as f64))
            .sum::<f64>()
            / centered_sample.rows as f64;
        explained_variance_ratio.push(if total_variance > 0.0 {
            variance / total_variance
        } else {
            0.0
        });
        components.push(vector);
    }

    let mut projected = Matrix {
        rows: track_count,
        cols: pca_dimensions,
        data: vec![0.0; track_count * pca_dimensions],
    };
    for row in 0..track_count {
        let output_offset = row * pca_dimensions;
        for (component_index, component) in components.iter().enumerate() {
            let mut score = 0.0f32;
            let embedding = &dataset.tracks[row].embedding;
            for dimension in 0..dimensions {
                score += (embedding[dimension] - mean[dimension] as f32) * component[dimension];
            }
            projected.data[output_offset + component_index] = score;
        }
    }
    normalize_rows(&mut projected);

    Ok((
        projected,
        PcaInfo {
            applied: true,
            input_dimensions: dimensions,
            output_dimensions: pca_dimensions,
            sample_size: sample_count,
            iterations: pca_iterations,
            explained_variance_ratio,
        },
    ))
}

fn nearest_centroid(row: &[f32], centroids: &[Vec<f32>]) -> (usize, f32) {
    let mut best_index = 0;
    let mut best_similarity = f32::NEG_INFINITY;
    for (index, centroid) in centroids.iter().enumerate() {
        let similarity = dot(row, centroid);
        if similarity > best_similarity {
            best_similarity = similarity;
            best_index = index;
        }
    }
    (best_index, best_similarity)
}

fn kmeans_plus_plus(features: &Matrix, k: usize, seed: u64) -> Result<Vec<Vec<f32>>, String> {
    if k == 0 || k > features.rows {
        return Err(format!("k must be between 1 and {}", features.rows));
    }

    let mut rng = ChaCha8Rng::seed_from_u64(seed);
    let first_index = rng.gen_range(0..features.rows);
    let mut centroids = vec![features.row(first_index).to_vec()];
    let mut distances: Vec<f32> = (0..features.rows)
        .map(|index| (1.0 - dot(features.row(index), &centroids[0])).max(0.0))
        .collect();

    while centroids.len() < k {
        let total: f64 = distances
            .iter()
            .map(|distance| (*distance as f64) * (*distance as f64))
            .sum();
        let next_index = if total <= f64::EPSILON {
            rng.gen_range(0..features.rows)
        } else {
            let mut threshold = rng.gen::<f64>() * total;
            let mut chosen = features.rows - 1;
            for (index, distance) in distances.iter().enumerate() {
                threshold -= (*distance as f64) * (*distance as f64);
                if threshold <= 0.0 {
                    chosen = index;
                    break;
                }
            }
            chosen
        };

        let centroid = features.row(next_index).to_vec();
        for (index, distance) in distances.iter_mut().enumerate() {
            let candidate = (1.0 - dot(features.row(index), &centroid)).max(0.0);
            if candidate < *distance {
                *distance = candidate;
            }
        }
        centroids.push(centroid);
    }
    Ok(centroids)
}

fn assign_rows(features: &Matrix, centroids: &[Vec<f32>]) -> (Vec<usize>, Vec<f32>) {
    #[cfg(feature = "rayon")]
    {
        let assigned: Vec<(usize, f32)> = (0..features.rows)
            .into_par_iter()
            .map(|index| nearest_centroid(features.row(index), centroids))
            .collect();
        assigned.into_iter().unzip()
    }

    #[cfg(not(feature = "rayon"))]
    {
        let mut labels = Vec::with_capacity(features.rows);
        let mut similarities = Vec::with_capacity(features.rows);
        for index in 0..features.rows {
            let (label, similarity) = nearest_centroid(features.row(index), centroids);
            labels.push(label);
            similarities.push(similarity);
        }
        (labels, similarities)
    }
}

fn centroids_for_labels(features: &Matrix, labels: &[usize], k: usize) -> Vec<Vec<f32>> {
    let mut sums = vec![0.0f32; k * features.cols];
    let mut counts = vec![0usize; k];
    for (row_index, &label) in labels.iter().enumerate() {
        counts[label] += 1;
        let offset = row_index * features.cols;
        let centroid_offset = label * features.cols;
        for dimension in 0..features.cols {
            sums[centroid_offset + dimension] += features.data[offset + dimension];
        }
    }

    (0..k)
        .map(|cluster| {
            let offset = cluster * features.cols;
            let mut centroid = sums[offset..offset + features.cols].to_vec();
            if counts[cluster] > 0 && norm(&centroid) > f32::EPSILON {
                normalize(&mut centroid);
            }
            centroid
        })
        .collect()
}

fn update_centroids(
    features: &Matrix,
    labels: &[usize],
    previous: &[Vec<f32>],
    k: usize,
) -> Vec<Vec<f32>> {
    let mut sums = vec![0.0f32; k * features.cols];
    let mut counts = vec![0usize; k];
    for (row_index, &label) in labels.iter().enumerate() {
        counts[label] += 1;
        let offset = row_index * features.cols;
        let centroid_offset = label * features.cols;
        for dimension in 0..features.cols {
            sums[centroid_offset + dimension] += features.data[offset + dimension];
        }
    }

    let mut centroids = Vec::with_capacity(k);
    for cluster in 0..k {
        let offset = cluster * features.cols;
        let mut centroid = sums[offset..offset + features.cols].to_vec();
        if counts[cluster] == 0 || norm(&centroid) <= f32::EPSILON {
            centroid.clone_from(&previous[cluster]);
        } else {
            normalize(&mut centroid);
        }
        centroids.push(centroid);
    }
    centroids
}

fn centroid_shift(previous: &[Vec<f32>], current: &[Vec<f32>]) -> f32 {
    previous
        .iter()
        .zip(current)
        .map(|(left, right)| {
            left.iter()
                .zip(right)
                .map(|(a, b)| (a - b) * (a - b))
                .sum::<f32>()
        })
        .map(f32::sqrt)
        .fold(0.0, f32::max)
}

fn cluster_sizes(labels: &[usize], k: usize) -> Vec<usize> {
    let mut sizes = vec![0usize; k];
    for &label in labels {
        sizes[label] += 1;
    }
    sizes
}

fn quality_metrics(
    features: &Matrix,
    labels: &[usize],
    centroids: &[Vec<f32>],
    k: usize,
    silhouette_sample_size: usize,
    seed: u64,
) -> QualityMetrics {
    let sizes = cluster_sizes(labels, k);
    let non_empty = sizes.iter().filter(|size| **size > 0).count();
    let min_cluster_size = sizes.iter().copied().min().unwrap_or(0);
    let max_cluster_size = sizes.iter().copied().max().unwrap_or(0);
    let mean_cluster_size = if k == 0 {
        0.0
    } else {
        labels.len() as f64 / k as f64
    };

    let (mean_intra_similarity, inertia) = labels
        .iter()
        .enumerate()
        .map(|(index, &label)| {
            let similarity = dot(features.row(index), &centroids[label]);
            (similarity as f64, (1.0 - similarity).max(0.0) as f64)
        })
        .fold(
            (0.0, 0.0),
            |(similarity_sum, inertia_sum), (similarity, inertia)| {
                (similarity_sum + similarity, inertia_sum + inertia)
            },
        );
    let count = labels.len().max(1) as f64;

    QualityMetrics {
        cluster_count: non_empty,
        min_cluster_size,
        max_cluster_size,
        mean_cluster_size,
        mean_intra_similarity: mean_intra_similarity / count,
        inertia,
        silhouette: silhouette_score(features, labels, k, silhouette_sample_size, seed),
    }
}

fn silhouette_score(
    features: &Matrix,
    labels: &[usize],
    k: usize,
    sample_size: usize,
    seed: u64,
) -> Option<f64> {
    if features.rows < 3 || k < 2 {
        return None;
    }
    let indices = sample_indices(features.rows, sample_size, seed);
    if indices.len() < 3 {
        return None;
    }

    let mut scores = Vec::with_capacity(indices.len());
    for (position, &row_index) in indices.iter().enumerate() {
        let own_label = labels[row_index];
        let mut distance_sums = vec![0.0f64; k];
        let mut counts = vec![0usize; k];
        for (other_position, &other_index) in indices.iter().enumerate() {
            if position == other_position {
                continue;
            }
            let other_label = labels[other_index];
            if other_label >= k {
                continue;
            }
            let distance = (1.0 - dot(features.row(row_index), features.row(other_index))).max(0.0);
            distance_sums[other_label] += distance as f64;
            counts[other_label] += 1;
        }

        let within = if counts[own_label] > 1 {
            distance_sums[own_label] / counts[own_label] as f64
        } else {
            0.0
        };
        let nearest_other = (0..k)
            .filter(|&cluster| cluster != own_label && counts[cluster] > 0)
            .map(|cluster| distance_sums[cluster] / counts[cluster] as f64)
            .fold(f64::INFINITY, f64::min);
        if !nearest_other.is_finite() {
            continue;
        }
        let denominator = within.max(nearest_other);
        if denominator > f64::EPSILON {
            scores.push((nearest_other - within) / denominator);
        }
    }

    if scores.is_empty() {
        None
    } else {
        Some(scores.iter().sum::<f64>() / scores.len() as f64)
    }
}

fn baseline_labels(dataset: &Dataset) -> Vec<Option<usize>> {
    let mut mapping = HashMap::new();
    dataset
        .tracks
        .iter()
        .map(|track| {
            track
                .cluster_id
                .filter(|cluster_id| *cluster_id >= 0)
                .map(|cluster_id| {
                    let next_index = mapping.len();
                    *mapping.entry(cluster_id).or_insert(next_index)
                })
        })
        .collect()
}

fn baseline_metrics(
    features: &Matrix,
    dataset: &Dataset,
    sample_size: usize,
    seed: u64,
) -> Option<QualityMetrics> {
    let labels = baseline_labels(dataset);
    let labeled_indices: Vec<usize> = labels
        .iter()
        .enumerate()
        .filter_map(|(index, label)| label.map(|label| (index, label)))
        .map(|(index, _)| index)
        .collect();
    if labeled_indices.len() < 2 {
        return None;
    }

    let dense_labels: Vec<usize> = labeled_indices
        .iter()
        .map(|index| labels[*index].unwrap())
        .collect();
    let k = dense_labels.iter().copied().max().unwrap_or(0) + 1;
    let labeled_features = select_rows(features, &labeled_indices);
    let centroids = centroids_for_labels(&labeled_features, &dense_labels, k);
    Some(quality_metrics(
        &labeled_features,
        &dense_labels,
        &centroids,
        k,
        sample_size,
        seed,
    ))
}

fn adjusted_rand_index(labels_a: &[usize], labels_b: &[Option<usize>]) -> Option<f64> {
    if labels_a.len() != labels_b.len() {
        return None;
    }
    let valid_indices: Vec<usize> = labels_b
        .iter()
        .enumerate()
        .filter_map(|(index, label)| label.map(|label| (index, label)))
        .map(|(index, _)| index)
        .collect();
    if valid_indices.len() < 2 {
        return None;
    }

    let max_a = labels_a.iter().copied().max().unwrap_or(0);
    let max_b = labels_b.iter().flatten().copied().max().unwrap_or(0);
    let mut contingency = HashMap::<(usize, usize), usize>::new();
    let mut row_counts = vec![0usize; max_a + 1];
    let mut column_counts = vec![0usize; max_b + 1];
    for &index in &valid_indices {
        let a = labels_a[index];
        let b = labels_b[index].unwrap();
        *contingency.entry((a, b)).or_insert(0) += 1;
        row_counts[a] += 1;
        column_counts[b] += 1;
    }

    let choose_two = |value: usize| (value * value.saturating_sub(1)) / 2;
    let cells = contingency.values().copied().map(choose_two).sum::<usize>();
    let rows = row_counts.into_iter().map(choose_two).sum::<usize>();
    let columns = column_counts.into_iter().map(choose_two).sum::<usize>();
    let total_pairs = choose_two(valid_indices.len());
    if total_pairs == 0 {
        return None;
    }
    let expected = rows as f64 * columns as f64 / total_pairs as f64;
    let maximum = (rows + columns) as f64 / 2.0;
    if (maximum - expected).abs() < f64::EPSILON {
        return Some(1.0);
    }
    Some((cells as f64 - expected) / (maximum - expected))
}

fn run_spherical_kmeans(
    features: &Matrix,
    config: &BenchmarkConfig,
    seed: u64,
) -> Result<RunResult, String> {
    let mut centroids = kmeans_plus_plus(features, config.k, seed)?;
    let mut labels = vec![0usize; features.rows];
    let mut converged = false;
    let mut iterations = 0;

    for iteration in 0..config.max_iterations {
        let (next_labels, _) = assign_rows(features, &centroids);
        let next_centroids = update_centroids(features, &next_labels, &centroids, config.k);
        let shift = centroid_shift(&centroids, &next_centroids);
        let unchanged = next_labels == labels;
        labels = next_labels;
        centroids = next_centroids;
        iterations = iteration + 1;
        if shift <= config.tolerance || unchanged {
            converged = true;
            break;
        }
    }

    let (_, final_similarities) = assign_rows(features, &centroids);
    let inertia = final_similarities
        .iter()
        .map(|similarity| (1.0 - similarity).max(0.0) as f64)
        .sum();
    // Quality metrics are calculated later in the fixed evaluation space. This
    // avoids running an expensive silhouette pass in the training space too.
    let metrics = QualityMetrics {
        cluster_count: 0,
        min_cluster_size: 0,
        max_cluster_size: 0,
        mean_cluster_size: 0.0,
        mean_intra_similarity: 0.0,
        inertia,
        silhouette: None,
    };

    Ok(RunResult {
        seed,
        labels,
        centroids,
        iterations,
        converged,
        training_inertia: inertia,
        metrics,
        adjusted_rand_index_vs_current: None,
    })
}

/// Run PCA (optional) followed by multiple deterministic spherical k-means runs.
pub fn benchmark(dataset: &Dataset, config: &BenchmarkConfig) -> Result<BenchmarkResult, String> {
    if dataset.tracks.is_empty() {
        return Err("dataset is empty".to_string());
    }
    if config.k == 0 {
        return Err("k must be greater than zero".to_string());
    }
    if config.runs == 0 {
        return Err("runs must be greater than zero".to_string());
    }
    if config.max_iterations == 0 {
        return Err("max_iterations must be greater than zero".to_string());
    }
    let dimensions = dataset.dimensions()?;
    if config.pca_dimensions > 0 && config.pca_dimensions < dimensions && config.pca_iterations == 0
    {
        return Err("pca_iterations must be greater than zero when PCA is enabled".to_string());
    }
    if !config.tolerance.is_finite() || config.tolerance < 0.0 {
        return Err("tolerance must be a finite non-negative number".to_string());
    }

    let (features, pca) = pca_projection(
        dataset,
        dimensions,
        config.pca_dimensions,
        config.pca_iterations,
        config.pca_sample_size,
        config.seed,
    )?;
    if config.k > features.rows {
        return Err(format!(
            "k ({}) cannot exceed the number of projected tracks ({})",
            config.k, features.rows
        ));
    }

    // Keep quality metrics in one fixed space so runs with different training
    // dimensions remain comparable. The default reuses the 32-dimensional
    // training projection; other configurations fit a separate evaluation PCA.
    let (evaluation_features, evaluation_pca) =
        if config.pca_dimensions == config.evaluation_dimensions {
            (features.clone(), pca.clone())
        } else {
            pca_projection(
                dataset,
                dimensions,
                config.evaluation_dimensions,
                config.pca_iterations,
                config.pca_sample_size,
                config.seed,
            )?
        };

    let current_labels = baseline_labels(dataset);
    let current_assignments = baseline_metrics(
        &evaluation_features,
        dataset,
        config.metric_sample_size,
        config.seed,
    );
    let mut runs = Vec::with_capacity(config.runs);
    for run_index in 0..config.runs {
        let seed = config.seed.wrapping_add(run_index as u64);
        let mut run = run_spherical_kmeans(&features, config, seed)?;
        let evaluation_centroids =
            centroids_for_labels(&evaluation_features, &run.labels, config.k);
        run.metrics = quality_metrics(
            &evaluation_features,
            &run.labels,
            &evaluation_centroids,
            config.k,
            config.metric_sample_size,
            seed,
        );
        run.adjusted_rand_index_vs_current = adjusted_rand_index(&run.labels, &current_labels);
        runs.push(run);
    }

    let best_run = runs
        .iter()
        .enumerate()
        .min_by(|(_, left), (_, right)| {
            left.training_inertia
                .partial_cmp(&right.training_inertia)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(index, _)| index)
        .unwrap_or(0);

    Ok(BenchmarkResult {
        config: config.clone(),
        pca,
        evaluation_pca,
        current_assignments,
        runs,
        best_run,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(uri: &str, cluster_id: Option<i32>, embedding: Vec<f32>) -> TrackEmbedding {
        TrackEmbedding {
            uri: uri.into(),
            name: uri.into(),
            cluster_id,
            embedding,
        }
    }

    #[test]
    fn normalizes_rows() {
        let mut matrix = Matrix::from_rows(vec![vec![3.0, 4.0], vec![0.0, 2.0]]).unwrap();
        normalize_rows(&mut matrix);
        assert!((matrix.row(0)[0] - 0.6).abs() < 1e-6);
        assert!((matrix.row(0)[1] - 0.8).abs() < 1e-6);
        assert!((matrix.row(1)[1] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn finds_two_angular_clusters() {
        let mut first = Vec::new();
        let mut second = Vec::new();
        for index in 0..10 {
            let offset = index as f32 * 0.001;
            first.push([1.0 + offset, 0.1 + offset, 0.0]);
            second.push([0.0, 1.0 + offset, 0.1 + offset]);
        }
        let tracks = first
            .into_iter()
            .chain(second)
            .enumerate()
            .map(|(index, embedding)| track(&format!("t{index}"), None, embedding.to_vec()))
            .collect();
        let dataset = Dataset { tracks };
        let config = BenchmarkConfig {
            k: 2,
            pca_dimensions: 0,
            evaluation_dimensions: 2,
            pca_iterations: 4,
            pca_sample_size: 100,
            runs: 1,
            max_iterations: 30,
            tolerance: 0.0001,
            seed: 7,
            metric_sample_size: 100,
        };
        let result = benchmark(&dataset, &config).unwrap();
        assert_eq!(result.runs[0].metrics.cluster_count, 2);
        assert!(result.runs[0].metrics.mean_intra_similarity > 0.9);
    }

    #[test]
    fn identical_partitions_have_ari_one() {
        let labels = vec![0, 0, 1, 1, 2, 2];
        let current = vec![Some(0), Some(0), Some(1), Some(1), Some(2), Some(2)];
        assert!((adjusted_rand_index(&labels, &current).unwrap() - 1.0).abs() < 1e-9);
    }
}
