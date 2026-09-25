use anyhow::{anyhow, Result};

#[cfg(feature = "soxr-resampler")]
use soxr::format::Mono;
#[cfg(feature = "soxr-resampler")]
use soxr::Soxr;

/// Resample mono f32 audio to the OpenL3 input rate.
///
/// The production image enables `soxr-resampler`, which uses the same high
/// quality libsoxr backend selected by the current librosa version. A small
/// pure-Rust interpolating fallback keeps unit tests and source builds useful
/// on machines without libsoxr; it is deliberately not the parity path.
pub fn resample_to_target(samples: &[f32], input_rate: u32, target_rate: u32) -> Result<Vec<f32>> {
    if input_rate == 0 || target_rate == 0 {
        return Err(anyhow!("sample rates must be non-zero"));
    }
    if input_rate == target_rate {
        return Ok(samples.to_vec());
    }

    #[cfg(feature = "soxr-resampler")]
    {
        let output = resample_with_soxr(samples, input_rate, target_rate)?;
        Ok(fix_output_length(
            output,
            librosa_output_length(samples.len(), input_rate, target_rate),
        ))
    }

    #[cfg(not(feature = "soxr-resampler"))]
    {
        let output = resample_linear(samples, input_rate, target_rate);
        Ok(fix_output_length(
            output,
            librosa_output_length(samples.len(), input_rate, target_rate),
        ))
    }
}

// librosa computes the ratio first and then ceil()s the product. Keeping that
// operation order matters at exact ratios such as 44,100 -> 48,000, where the
// Python default adds one trailing zero because of floating-point rounding.
fn librosa_output_length(input_len: usize, input_rate: u32, target_rate: u32) -> usize {
    let ratio = target_rate as f64 / input_rate as f64;
    (input_len as f64 * ratio).ceil().max(0.0) as usize
}

fn fix_output_length(mut output: Vec<f32>, expected: usize) -> Vec<f32> {
    output.resize(expected, 0.0);
    output
}

#[cfg(feature = "soxr-resampler")]
fn resample_with_soxr(samples: &[f32], input_rate: u32, target_rate: u32) -> Result<Vec<f32>> {
    let mut resampler = Soxr::<Mono<f32>>::new(input_rate as f64, target_rate as f64)
        .map_err(|error| anyhow!("create soxr resampler: {error}"))?;
    let ratio = target_rate as f64 / input_rate as f64;
    let mut output = Vec::with_capacity((samples.len() as f64 * ratio).ceil() as usize + 64);
    let mut input_offset = 0;

    while input_offset < samples.len() {
        let input = &samples[input_offset..];
        let estimate = ((input.len() as f64 * ratio).ceil() as usize + 64).max(128);
        let mut buffer = vec![0.0_f32; estimate];
        let processed = resampler
            .process(input, &mut buffer)
            .map_err(|error| anyhow!("soxr process: {error}"))?;
        output.extend_from_slice(&buffer[..processed.output_frames]);
        if processed.input_frames == 0 && processed.output_frames == 0 {
            return Err(anyhow!("soxr made no progress"));
        }
        input_offset += processed.input_frames;
    }

    loop {
        let mut buffer = vec![0.0_f32; 128];
        let produced = resampler
            .drain(&mut buffer)
            .map_err(|error| anyhow!("soxr drain: {error}"))?;
        if produced == 0 {
            break;
        }
        output.extend_from_slice(&buffer[..produced]);
    }
    Ok(output)
}

#[cfg(not(feature = "soxr-resampler"))]
fn resample_linear(samples: &[f32], input_rate: u32, target_rate: u32) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }
    let output_len =
        ((samples.len() as f64 * target_rate as f64 / input_rate as f64).ceil() as usize).max(1);
    let step = input_rate as f64 / target_rate as f64;
    let mut output = Vec::with_capacity(output_len);
    for index in 0..output_len {
        let position = index as f64 * step;
        let left = position.floor() as usize;
        let fraction = (position - left as f64) as f32;
        let right = (left + 1).min(samples.len() - 1);
        output.push(samples[left] * (1.0 - fraction) + samples[right] * fraction);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noop_preserves_samples() {
        let samples = vec![0.0, 0.25, -0.5, 1.0];
        assert_eq!(
            resample_to_target(&samples, 48_000, 48_000).unwrap(),
            samples
        );
    }

    #[test]
    fn fallback_changes_length_for_nontrivial_ratio() {
        let samples = vec![0.0, 1.0, 0.0, -1.0];
        let output = resample_to_target(&samples, 44_100, 48_000).unwrap();
        assert!(output.len() >= 4);
        assert!(output.iter().all(|value| value.is_finite()));
    }

    #[test]
    fn matches_librosa_trailing_zero_for_exact_ratio() {
        let samples = vec![0.25; 88_200];
        let output = resample_to_target(&samples, 44_100, 48_000).unwrap();
        assert_eq!(output.len(), 96_001);
        assert_eq!(output.last().copied(), Some(0.0));
    }
}
