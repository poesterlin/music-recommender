use crate::{FRAME_SIZE, HOP_SIZE};

/// Center and pad audio exactly like OpenL3 0.4.2's
/// `_preprocess_audio_batch` before its Kapre frontend.
pub fn center_and_pad(samples: &[f32]) -> Vec<f32> {
    let centered_len = samples.len() + FRAME_SIZE / 2;
    let frame_count = if centered_len <= FRAME_SIZE {
        1
    } else {
        1 + (centered_len - FRAME_SIZE).div_ceil(HOP_SIZE)
    };
    let padded_len = FRAME_SIZE + (frame_count - 1) * HOP_SIZE;
    let mut padded = Vec::with_capacity(padded_len);
    padded.resize(FRAME_SIZE / 2, 0.0);
    padded.extend_from_slice(samples);
    padded.resize(padded_len, 0.0);
    padded
}

pub fn frame_count(samples: &[f32]) -> usize {
    let centered_len = samples.len() + FRAME_SIZE / 2;
    if centered_len <= FRAME_SIZE {
        1
    } else {
        1 + (centered_len - FRAME_SIZE).div_ceil(HOP_SIZE)
    }
}

pub fn frame_at(padded: &[f32], index: usize) -> &[f32] {
    let start = index * HOP_SIZE;
    &padded[start..start + FRAME_SIZE]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_audio_is_padded_to_one_frame() {
        let padded = center_and_pad(&[0.25; 100]);
        assert_eq!(padded.len(), FRAME_SIZE);
        assert_eq!(frame_count(&[0.25; 100]), 1);
        assert_eq!(padded[FRAME_SIZE / 2], 0.25);
    }

    #[test]
    fn framing_matches_openl3_padding_formula() {
        for length in [FRAME_SIZE, 96_001, 144_001, 200_000] {
            let padded = center_and_pad(&vec![0.0; length]);
            let expected_frames = if length + FRAME_SIZE / 2 <= FRAME_SIZE {
                1
            } else {
                1 + (length + FRAME_SIZE / 2 - FRAME_SIZE).div_ceil(HOP_SIZE)
            };
            assert_eq!(padded.len(), FRAME_SIZE + (expected_frames - 1) * HOP_SIZE);
            assert_eq!(frame_count(&vec![0.0; length]), expected_frames);
        }
    }
}
