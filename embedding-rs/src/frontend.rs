use std::sync::Arc;

use anyhow::{anyhow, Result};
use rayon::prelude::*;
use rustfft::num_complex::Complex32;
use rustfft::{Fft, FftPlanner};

use crate::embed::Frontend;
use crate::FRAME_SIZE;

const SAMPLE_RATE: f64 = 48_000.0;
const N_FFT: usize = 2_048;
const HOP: usize = 242;
const FREQUENCY_BINS: usize = N_FFT / 2 + 1;
const MEL_BINS: usize = 256;
const FRONTEND_FRAMES: usize = 199;
// OpenL3 0.4.2 replaces Kapre's 1e-5 default with this compatibility layer.
const DB_FLOOR: f32 = 1e-10;

/// A Rust implementation of the frontend embedded in OpenL3's
/// `openl3_audio_mel256_music` model.
///
/// The network-only ONNX artifact receives the same channels-first tensor that
/// Kapre produces after the OpenL3 wrapper's final permutation:
/// `[256 mel bins, 199 time frames, 1 channel]`.
pub struct KapreFrontend {
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    mel: Vec<f32>,
}

impl KapreFrontend {
    pub fn new() -> Result<Self> {
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(N_FFT);
        let window = (0..N_FFT)
            .map(|index| {
                // tf.signal.hann_window(periodic=True)
                0.5_f32 - 0.5_f32 * (2.0 * std::f32::consts::PI * index as f32 / N_FFT as f32).cos()
            })
            .collect();
        let mel = build_mel_filterbank();
        Ok(Self { fft, window, mel })
    }

    pub fn mel256(&self, audio_frame: &[f32]) -> Result<Vec<f32>> {
        if audio_frame.len() != FRAME_SIZE {
            return Err(anyhow!(
                "Kapre frontend input has {} samples; expected {}",
                audio_frame.len(),
                FRAME_SIZE
            ));
        }
        let frame_values = (0..FRONTEND_FRAMES)
            .into_par_iter()
            .map(|time| self.compute_mel_frame(audio_frame, time))
            .collect::<Vec<_>>();
        let mut mel_values = vec![0.0_f32; MEL_BINS * FRONTEND_FRAMES];
        for (time, values) in frame_values.into_iter().enumerate() {
            for (mel, value) in values.into_iter().enumerate() {
                mel_values[mel * FRONTEND_FRAMES + time] = value;
            }
        }

        let mut maximum = f32::NEG_INFINITY;
        for &value in &mel_values {
            maximum = maximum.max(value);
        }
        let peak_db = maximum_db(maximum);
        for value in &mut mel_values {
            let db = maximum_db(*value) - peak_db;
            *value = db.max(-80.0);
        }
        Ok(mel_values)
    }
    fn compute_mel_frame(&self, audio_frame: &[f32], time: usize) -> Vec<f32> {
        let mut fft_input = vec![Complex32::new(0.0, 0.0); N_FFT];
        let mut magnitudes = vec![0.0_f32; FREQUENCY_BINS];
        let start = time * HOP;
        let available = (FRAME_SIZE - start).min(N_FFT);
        for index in 0..available {
            fft_input[index] = Complex32::new(audio_frame[start + index] * self.window[index], 0.0);
        }
        self.fft.process(&mut fft_input);

        for (frequency, magnitude) in magnitudes.iter_mut().enumerate() {
            let value = fft_input[frequency];
            *magnitude = (value.re * value.re + value.im * value.im).sqrt();
        }

        let mut mel_values = vec![0.0_f32; MEL_BINS];
        for (mel, output) in mel_values.iter_mut().enumerate() {
            let mut sum = 0.0_f32;
            for (frequency, magnitude) in magnitudes.iter().enumerate() {
                sum += *magnitude * self.mel[frequency * MEL_BINS + mel];
            }
            *output = sum;
        }
        mel_values
    }
}

impl Frontend for KapreFrontend {
    fn mel256(&self, audio_frame: &[f32]) -> Result<Vec<f32>> {
        KapreFrontend::mel256(self, audio_frame)
    }
}

fn maximum_db(value: f32) -> f32 {
    10.0 * value.max(DB_FLOOR).ln() / 10.0_f32.ln()
}

fn build_mel_filterbank() -> Vec<f32> {
    let mut filterbank = vec![0.0_f32; FREQUENCY_BINS * MEL_BINS];
    let f_max = SAMPLE_RATE / 2.0;
    let min_mel = hz_to_mel(0.0);
    let max_mel = hz_to_mel(f_max);
    let mut mel_frequencies = vec![0.0_f64; MEL_BINS + 2];
    for (index, frequency) in mel_frequencies.iter_mut().enumerate() {
        let mel = min_mel + (max_mel - min_mel) * index as f64 / (MEL_BINS + 1) as f64;
        *frequency = mel_to_hz(mel);
    }

    for mel in 0..MEL_BINS {
        let lower_width = mel_frequencies[mel + 1] - mel_frequencies[mel];
        let upper_width = mel_frequencies[mel + 2] - mel_frequencies[mel + 1];
        let scale = 2.0 / (mel_frequencies[mel + 2] - mel_frequencies[mel]);
        for frequency in 0..FREQUENCY_BINS {
            let fft_frequency = SAMPLE_RATE * frequency as f64 / N_FFT as f64;
            let lower = -(mel_frequencies[mel] - fft_frequency) / lower_width;
            let upper = (mel_frequencies[mel + 2] - fft_frequency) / upper_width;
            filterbank[frequency * MEL_BINS + mel] = (lower.min(upper).max(0.0) * scale) as f32;
        }
    }
    filterbank
}

fn hz_to_mel(frequency: f64) -> f64 {
    let f_sp = 200.0 / 3.0;
    let min_log_hz = 1000.0;
    let min_log_mel = min_log_hz / f_sp;
    let logstep = 6.4_f64.ln() / 27.0;
    if frequency >= min_log_hz {
        min_log_mel + (frequency / min_log_hz).ln() / logstep
    } else {
        frequency / f_sp
    }
}

fn mel_to_hz(mel: f64) -> f64 {
    let f_sp = 200.0 / 3.0;
    let min_log_hz = 1000.0;
    let min_log_mel = min_log_hz / f_sp;
    let logstep = 6.4_f64.ln() / 27.0;
    if mel >= min_log_mel {
        min_log_hz * (logstep * (mel - min_log_mel)).exp()
    } else {
        f_sp * mel
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_expected_frontend_shape() {
        let frontend = KapreFrontend::new().unwrap();
        let output = frontend.mel256(&vec![0.0; FRAME_SIZE]).unwrap();
        assert_eq!(output.len(), MEL_BINS * FRONTEND_FRAMES);
        assert!(output.iter().all(|value| value.is_finite()));
    }

    #[test]
    fn processes_a_signal_at_the_last_stft_frame() {
        let frontend = KapreFrontend::new().unwrap();
        let mut frame = vec![0.0; FRAME_SIZE];
        for value in &mut frame[FRAME_SIZE - 84..] {
            *value = 0.5;
        }
        let output = frontend.mel256(&frame).unwrap();
        assert!(output[(128 * FRONTEND_FRAMES) + 198] > -79.0);
    }

    #[test]
    fn hann_window_has_periodic_endpoints() {
        let frontend = KapreFrontend::new().unwrap();
        assert_eq!(frontend.window[0], 0.0);
        assert!(frontend.window[1] > 0.0);
        assert!(frontend.window[N_FFT - 1] > 0.0);
    }
}
