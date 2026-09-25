use anyhow::{anyhow, Result};

#[derive(Clone, Copy, Debug)]
pub struct VectorMetrics {
    pub max_abs_error: f32,
    pub mean_abs_error: f32,
    pub l2_error: f32,
    pub cosine: f32,
}

pub fn compare_vectors(expected: &[f32], actual: &[f32]) -> Result<VectorMetrics> {
    if expected.len() != actual.len() || expected.is_empty() {
        return Err(anyhow!(
            "vector dimensions differ: expected {}, got {}",
            expected.len(),
            actual.len()
        ));
    }
    let mut max_abs_error = 0.0_f32;
    let mut abs_sum = 0.0_f64;
    let mut squared_error = 0.0_f64;
    let mut dot = 0.0_f64;
    let mut expected_norm = 0.0_f64;
    let mut actual_norm = 0.0_f64;
    for (&left, &right) in expected.iter().zip(actual) {
        if !left.is_finite() || !right.is_finite() {
            return Err(anyhow!("vectors contain a non-finite value"));
        }
        let error = (left - right).abs();
        max_abs_error = max_abs_error.max(error);
        abs_sum += error as f64;
        squared_error += (error as f64) * (error as f64);
        dot += left as f64 * right as f64;
        expected_norm += left as f64 * left as f64;
        actual_norm += right as f64 * right as f64;
    }
    let denominator = (expected_norm * actual_norm).sqrt();
    let cosine = if denominator == 0.0 {
        0.0
    } else {
        (dot / denominator) as f32
    };
    Ok(VectorMetrics {
        max_abs_error,
        mean_abs_error: (abs_sum / expected.len() as f64) as f32,
        l2_error: squared_error.sqrt() as f32,
        cosine,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_nearby_vectors() {
        let metrics = compare_vectors(&[1.0, 0.0, -1.0], &[1.0, 0.1, -0.9]).unwrap();
        assert!(metrics.max_abs_error > 0.09);
        assert!(metrics.cosine > 0.99);
    }

    #[test]
    fn rejects_dimension_mismatch() {
        assert!(compare_vectors(&[1.0], &[1.0, 2.0]).is_err());
    }
}
