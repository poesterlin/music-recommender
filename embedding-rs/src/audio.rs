use std::fs::File;
use std::path::Path;

use anyhow::{anyhow, Context, Result};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

#[derive(Clone, Debug)]
pub struct DecodedAudio {
    pub sample_rate: u32,
    pub samples: Vec<f32>,
}

/// Decode the first audio track and downmix it to mono f32 samples.
///
/// `duration_seconds` is applied at the source sample rate, matching the
/// `librosa.load(..., duration=...)` boundary used by the reference worker.
/// Symphonia is the primary decoder. When the `ffmpeg-fallback` feature is
/// enabled, formats that its probe cannot handle (notably some M4A files)
/// use the same ffmpeg/audioread path as the legacy Python worker.
pub fn decode_mono(path: impl AsRef<Path>, duration_seconds: Option<f64>) -> Result<DecodedAudio> {
    let path = path.as_ref();
    #[cfg(feature = "ffmpeg-fallback")]
    if std::env::var_os("MUSIC_EMBEDDING_FORCE_FFMPEG").is_some()
        || matches!(
            path.extension()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("m4a" | "mp4")
        )
    {
        return decode_mono_ffmpeg(path, duration_seconds);
    }
    decode_mono_with_fallback(path, duration_seconds)
}

fn decode_mono_with_fallback(path: &Path, duration_seconds: Option<f64>) -> Result<DecodedAudio> {
    let primary = decode_mono_sndfile_or_symphonia(path, duration_seconds);
    #[cfg(feature = "ffmpeg-fallback")]
    {
        match primary {
            Ok(decoded) => Ok(decoded),
            Err(primary_error) => decode_mono_ffmpeg(path, duration_seconds).with_context(|| {
                format!("primary decoder failed ({primary_error}); ffmpeg fallback also failed")
            }),
        }
    }
    #[cfg(not(feature = "ffmpeg-fallback"))]
    {
        primary
    }
}

#[cfg(feature = "libsndfile-decoder")]
fn decode_mono_sndfile_or_symphonia(
    path: &Path,
    duration_seconds: Option<f64>,
) -> Result<DecodedAudio> {
    match decode_mono_sndfile(path, duration_seconds) {
        Ok(decoded) => Ok(decoded),
        Err(_) => decode_mono_symphonia(path, duration_seconds),
    }
}

#[cfg(not(feature = "libsndfile-decoder"))]
fn decode_mono_sndfile_or_symphonia(
    path: &Path,
    duration_seconds: Option<f64>,
) -> Result<DecodedAudio> {
    decode_mono_symphonia(path, duration_seconds)
}

#[cfg(feature = "libsndfile-decoder")]
fn decode_mono_sndfile(path: &Path, duration_seconds: Option<f64>) -> Result<DecodedAudio> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::ptr;

    use sndfile_sys as sf;

    struct Handle(*mut sf::SNDFILE);
    impl Drop for Handle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    sf::sf_close(self.0);
                }
            }
        }
    }

    let path_c = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| anyhow!("audio path contains an interior NUL byte"))?;
    let mut info = sf::SF_INFO {
        frames: 0,
        samplerate: 0,
        channels: 0,
        format: 0,
        sections: 0,
        seekable: 0,
    };
    let handle = unsafe { sf::sf_open(path_c.as_ptr(), sf::SFM_READ, &mut info) };
    if handle.is_null() {
        let error = unsafe {
            let code = sf::sf_error(ptr::null_mut());
            let pointer = sf::sf_error_number(code);
            if pointer.is_null() {
                format!("libsndfile error {code}")
            } else {
                std::ffi::CStr::from_ptr(pointer)
                    .to_string_lossy()
                    .into_owned()
            }
        };
        return Err(anyhow!(
            "libsndfile could not open {}: {error}",
            path.display()
        ));
    }
    let handle = Handle(handle);
    let sample_rate = info.samplerate as u32;
    let channels = info.channels as usize;
    if sample_rate == 0 || channels == 0 || info.frames < 0 {
        return Err(anyhow!("libsndfile returned invalid audio metadata"));
    }
    let available_frames = info.frames as usize;
    let limit = duration_seconds
        .map(|seconds| (seconds * sample_rate as f64).floor().max(0.0) as usize)
        .unwrap_or(available_frames)
        .min(available_frames);
    if limit == 0 {
        return Err(anyhow!("libsndfile returned no audio frames"));
    }

    let mut mono = Vec::with_capacity(limit);
    let mut buffer = vec![0.0_f32; 4096 * channels];
    let mut frames_read = 0_usize;
    while frames_read < limit {
        let requested_frames = (limit - frames_read).min(buffer.len() / channels);
        let read_frames = unsafe {
            sf::sf_readf_float(
                handle.0,
                buffer.as_mut_ptr(),
                requested_frames as sf::sf_count_t,
            )
        };
        if read_frames < 0 {
            return Err(anyhow!("libsndfile read failed"));
        }
        let read_frames = read_frames as usize;
        if read_frames == 0 {
            break;
        }
        for frame in 0..read_frames {
            let start = frame * channels;
            let sum: f32 = buffer[start..start + channels].iter().sum();
            mono.push(sum / channels as f32);
        }
        frames_read += read_frames;
    }
    if mono.is_empty() {
        return Err(anyhow!("libsndfile returned no audio samples"));
    }
    Ok(DecodedAudio {
        sample_rate,
        samples: mono,
    })
}

fn decode_mono_symphonia(path: &Path, duration_seconds: Option<f64>) -> Result<DecodedAudio> {
    let file = File::open(path).with_context(|| format!("open audio file {}", path.display()))?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }

    let format_options = FormatOptions::default();
    let metadata_options = MetadataOptions::default();
    let probed = symphonia::default::get_probe()
        .format(&hint, stream, &format_options, &metadata_options)
        .with_context(|| format!("probe audio file {}", path.display()))?;
    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| anyhow!("no decodable audio track in {}", path.display()))?;
    let track_id = track.id;
    let codec_params = track.codec_params.clone();
    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .with_context(|| format!("create decoder for {}", path.display()))?;

    let mut sample_rate = None;
    let mut mono = Vec::new();
    let mut source_limit = None;
    let mut sample_buffer = None;

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::ResetRequired) => {
                return Err(anyhow!(
                    "audio format reset while decoding {}",
                    path.display()
                ));
            }
            Err(SymphoniaError::IoError(error))
                if error.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(SymphoniaError::IoError(error)) => {
                return Err(error).with_context(|| format!("read audio packet {}", path.display()));
            }
            Err(error) => return Err(error.into()),
        };
        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(SymphoniaError::IoError(_)) => continue,
            Err(error) => return Err(error.into()),
        };
        let spec = *decoded.spec();
        let decoded_frames = decoded.frames();
        if spec.rate == 0 || spec.channels.count() == 0 {
            continue;
        }
        sample_rate.get_or_insert(spec.rate);
        if source_limit.is_none() {
            source_limit = duration_seconds
                .map(|seconds| (seconds * spec.rate as f64).floor().max(0.0) as usize);
        }

        if sample_buffer.is_none() {
            sample_buffer = Some(SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
        }
        let sample_buffer = sample_buffer
            .as_mut()
            .ok_or_else(|| anyhow!("failed to allocate sample conversion buffer"))?;
        sample_buffer.copy_interleaved_ref(decoded);
        let interleaved = sample_buffer.samples();
        let channels = spec.channels.count();
        let frames = decoded_frames;
        let already = mono.len();
        let remaining = source_limit
            .map(|limit| limit.saturating_sub(already))
            .unwrap_or(frames);
        let frames_to_copy = remaining.min(frames);
        mono.reserve(frames_to_copy);
        for frame in 0..frames_to_copy {
            let start = frame * channels;
            let sum: f32 = interleaved[start..start + channels].iter().sum();
            mono.push(sum / channels as f32);
        }
        if source_limit.is_some_and(|limit| mono.len() >= limit) {
            break;
        }
    }

    let sample_rate =
        sample_rate.ok_or_else(|| anyhow!("no audio samples in {}", path.display()))?;
    if let Some(limit) = source_limit {
        mono.truncate(limit);
    }
    if mono.is_empty() {
        return Err(anyhow!("audio file is empty: {}", path.display()));
    }
    Ok(DecodedAudio {
        sample_rate,
        samples: mono,
    })
}

#[cfg(feature = "ffmpeg-fallback")]
fn decode_mono_ffmpeg(path: &Path, duration_seconds: Option<f64>) -> Result<DecodedAudio> {
    use std::process::Command;

    let probe = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=sample_rate,channels",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .with_context(|| format!("run ffprobe for {}", path.display()))?;
    if !probe.status.success() {
        anyhow::bail!(
            "ffprobe failed for {}: {}",
            path.display(),
            String::from_utf8_lossy(&probe.stderr).trim()
        );
    }
    let metadata = String::from_utf8_lossy(&probe.stdout);
    let mut fields = metadata.trim().split(',');
    let sample_rate = fields
        .next()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .ok_or_else(|| anyhow!("ffprobe returned no sample rate for {}", path.display()))?;
    let channels = fields
        .next()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| anyhow!("ffprobe returned no channel count for {}", path.display()))?;

    // audioread stops after the requested duration; -t avoids decoding an
    // entire long M4A file before applying the same crop below.
    let mut command = Command::new("ffmpeg");
    command
        .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(path)
        .args(["-map", "0:a:0"]);
    if let Some(seconds) = duration_seconds {
        command.args(["-t", &format!("{seconds:.9}")]);
    }
    let output = command
        .args(["-f", "s16le", "-"])
        .output()
        .with_context(|| format!("run ffmpeg for {}", path.display()))?;
    if !output.status.success() {
        anyhow::bail!(
            "ffmpeg failed for {}: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    if output.stdout.len() % (2 * channels) != 0 {
        anyhow::bail!(
            "ffmpeg returned an incomplete audio frame for {}",
            path.display()
        );
    }

    let source_frames = output.stdout.len() / (2 * channels);
    let limit = duration_seconds
        .map(|seconds| {
            ((seconds * sample_rate as f64).floor().max(0.0) as usize).min(source_frames)
        })
        .unwrap_or(source_frames);
    let mut mono = Vec::with_capacity(limit);
    for frame in 0..limit {
        let start = frame * channels * 2;
        let mut sum = 0.0_f32;
        for channel in 0..channels {
            let offset = start + channel * 2;
            let sample = i16::from_le_bytes([output.stdout[offset], output.stdout[offset + 1]]);
            sum += sample as f32 / 32_768.0_f32;
        }
        mono.push(sum / channels as f32);
    }
    if mono.is_empty() {
        anyhow::bail!("ffmpeg returned no audio samples for {}", path.display());
    }
    Ok(DecodedAudio {
        sample_rate,
        samples: mono,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn rejects_missing_file() {
        let error = decode_mono("/definitely/not/an/audio/file.mp3", Some(1.0)).unwrap_err();
        assert!(error.to_string().contains("open audio file"));
    }

    #[test]
    fn writes_and_reads_a_small_wav() {
        // Keep a tiny PCM fixture local so decoder behavior is tested without
        // requiring the music volume in unit tests.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&52u32.to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&8_000u32.to_le_bytes());
        bytes.extend_from_slice(&8_000u32.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        for sample in [0_i16, 1_000, 2_000, 3_000, -3_000, -2_000, -1_000, 0] {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        let path =
            std::env::temp_dir().join(format!("music-embedding-test-{}.wav", std::process::id()));
        let mut file = File::create(&path).unwrap();
        file.write_all(&bytes).unwrap();
        let decoded = decode_mono(&path, Some(0.001)).unwrap();
        assert_eq!(decoded.sample_rate, 8_000);
        assert_eq!(decoded.samples.len(), 8);
        assert!((decoded.samples[1] - 1000.0 / 32768.0).abs() < 1e-7);
        let _ = std::fs::remove_file(path);
    }
}
