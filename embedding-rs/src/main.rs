use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::env;
use std::time::Instant;

use music_embedding::{
    center_and_pad, compare_vectors, decode_mono, embed_audio, frame_at, frame_count,
    load_embedding_model, resample_to_target, run_worker, KapreFrontend, WorkerArgs,
    TARGET_SAMPLE_RATE,
};

// Keep the conservative, already-validated backend as the default. The
// ONNX Runtime backend is built into the production image for benchmarking and
// can be selected explicitly with `--backend ort`.
const DEFAULT_BACKEND: &str = "tract";

#[derive(Debug, Parser)]
#[command(name = "embedding-worker", about = "Rust OpenL3 embedding worker")]
struct Args {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Decode and resample one file without loading the model.
    Decode {
        #[arg(long)]
        audio: std::path::PathBuf,
        #[arg(long, default_value_t = 60.0)]
        duration: f64,
    },
    /// Run only the Rust Kapre-compatible mel frontend and print hashes.
    Frontend {
        #[arg(long)]
        audio: std::path::PathBuf,
        #[arg(long, default_value_t = 60.0)]
        duration: f64,
        #[arg(long)]
        raw_output: Option<std::path::PathBuf>,
    },
    /// Run the Rust frontend and frontend-free OpenL3 network for one file.
    Embed {
        #[arg(long)]
        audio: std::path::PathBuf,
        #[arg(long)]
        model: std::path::PathBuf,
        #[arg(long)]
        metadata: std::path::PathBuf,
        #[arg(long, default_value = DEFAULT_BACKEND)]
        backend: String,
        #[arg(long, default_value_t = 60.0)]
        duration: f64,
        #[arg(long)]
        raw_output: Option<std::path::PathBuf>,
    },
    /// Compare an embedding JSON output with a reference fixture.
    Compare {
        #[arg(long)]
        reference: std::path::PathBuf,
        #[arg(long)]
        candidate: std::path::PathBuf,
    },
    /// Process the PostgreSQL backlog. This is a dry run unless both write
    /// flags are supplied.
    Worker {
        #[arg(long)]
        database_url: Option<String>,
        #[arg(long)]
        audio_dir: Option<std::path::PathBuf>,
        #[arg(long)]
        model: std::path::PathBuf,
        #[arg(long)]
        metadata: std::path::PathBuf,
        #[arg(long, default_value = DEFAULT_BACKEND)]
        backend: String,
        #[arg(long, default_value_t = 32)]
        batch_size: usize,
        #[arg(long)]
        limit: Option<usize>,
        #[arg(long)]
        uri: Option<String>,
        #[arg(long, default_value_t = 60.0)]
        duration: f64,
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        write: bool,
        #[arg(long)]
        confirm_write: bool,
        #[arg(long)]
        fail_fast: bool,
        #[arg(long)]
        max_errors: Option<usize>,
        #[arg(long)]
        report: Option<std::path::PathBuf>,
        #[arg(long)]
        include_vector: bool,
        #[arg(long, default_value_t = 1)]
        expected_space_version: i32,
        #[arg(long, default_value = "openl3-512")]
        expected_model: String,
    },
}

struct WorkerCommand {
    database_url: Option<String>,
    audio_dir: Option<std::path::PathBuf>,
    model: std::path::PathBuf,
    metadata: std::path::PathBuf,
    backend: String,
    batch_size: usize,
    limit: Option<usize>,
    uri: Option<String>,
    duration: f64,
    dry_run: bool,
    write: bool,
    confirm_write: bool,
    fail_fast: bool,
    max_errors: Option<usize>,
    report: Option<std::path::PathBuf>,
    include_vector: bool,
    expected_space_version: i32,
    expected_model: String,
}

fn worker_command(args: WorkerCommand) -> Result<()> {
    if args.dry_run && args.write {
        anyhow::bail!("--dry-run and --write are mutually exclusive");
    }
    if args.write && !args.confirm_write {
        anyhow::bail!("--write requires --confirm-write");
    }
    let database_url = args
        .database_url
        .or_else(|| env::var("DATABASE_URL").ok())
        .ok_or_else(|| anyhow::anyhow!("--database-url or DATABASE_URL is required"))?;
    let audio_dir = args
        .audio_dir
        .or_else(|| env::var("AUDIO_DIR").ok().map(std::path::PathBuf::from))
        .unwrap_or_else(|| std::path::PathBuf::from("/music"));
    run_worker(WorkerArgs {
        database_url,
        audio_dir,
        backend: args.backend,
        model_path: args.model,
        metadata_path: args.metadata,
        batch_size: args.batch_size,
        limit: args.limit,
        uri_filter: args.uri,
        duration_seconds: args.duration,
        write: args.write,
        confirm_write: args.confirm_write,
        fail_fast: args.fail_fast,
        max_errors: args.max_errors,
        report_path: args.report,
        include_vector: args.include_vector,
        expected_space_version: args.expected_space_version,
        expected_model: args.expected_model,
    })
}

fn main() -> Result<()> {
    match Args::parse().command {
        Command::Decode { audio, duration } => decode_command(&audio, duration),
        Command::Frontend {
            audio,
            duration,
            raw_output,
        } => frontend_command(&audio, duration, raw_output.as_deref()),
        Command::Embed {
            audio,
            model,
            metadata,
            backend,
            duration,
            raw_output,
        } => embed_command(
            &audio,
            &model,
            &metadata,
            &backend,
            duration,
            raw_output.as_deref(),
        ),
        Command::Compare {
            reference,
            candidate,
        } => compare_command(&reference, &candidate),
        Command::Worker {
            database_url,
            audio_dir,
            model,
            metadata,
            backend,
            batch_size,
            limit,
            uri,
            duration,
            dry_run,
            write,
            confirm_write,
            fail_fast,
            max_errors,
            report,
            include_vector,
            expected_space_version,
            expected_model,
        } => worker_command(WorkerCommand {
            database_url,
            audio_dir,
            model,
            metadata,
            backend,
            batch_size,
            limit,
            uri,
            duration,
            dry_run,
            write,
            confirm_write,
            fail_fast,
            max_errors,
            report,
            include_vector,
            expected_space_version,
            expected_model,
        }),
    }
}

fn frontend_command(
    path: &std::path::Path,
    duration: f64,
    raw_output: Option<&std::path::Path>,
) -> Result<()> {
    let decoded = decode_mono(path, Some(duration))?;
    let samples = resample_to_target(&decoded.samples, decoded.sample_rate, TARGET_SAMPLE_RATE)?;
    let padded = center_and_pad(&samples);
    let frontend = KapreFrontend::new()?;
    let count = frame_count(&samples);
    let frame_maxima = (0..count.min(4))
        .map(|index| {
            frame_at(&padded, index)
                .iter()
                .copied()
                .fold(0.0_f32, |value, sample| value.max(sample.abs()))
        })
        .collect::<Vec<_>>();
    let mut values = Vec::with_capacity(count * frontend_output_size());
    for index in 0..count {
        values.extend(frontend.mel256(frame_at(&padded, index))?);
    }
    let raw_bytes: Vec<u8> = values
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect();
    if let Some(path) = raw_output {
        std::fs::write(path, &raw_bytes)
            .map_err(|error| anyhow::anyhow!("write {}: {error}", path.display()))?;
    }
    let digest = Sha256::digest(&raw_bytes);
    let value = json!({
        "path": path,
        "sourceSampleRate": decoded.sample_rate,
        "sourceSampleCount": decoded.samples.len(),
        "resampledSampleCount": samples.len(),
        "frameCount": count,
        "frameShape": [256, 199, 1],
        "frameMaxima": frame_maxima,
        "sha256": format!("{digest:x}"),
        "min": values.iter().copied().fold(f32::INFINITY, f32::min),
        "max": values.iter().copied().fold(f32::NEG_INFINITY, f32::max),
        "first": values.iter().take(20).copied().collect::<Vec<_>>(),
    });
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}

fn compare_command(
    reference_path: &std::path::Path,
    candidate_path: &std::path::Path,
) -> Result<()> {
    let reference: serde_json::Value = serde_json::from_reader(
        std::fs::File::open(reference_path)
            .with_context(|| format!("open reference {}", reference_path.display()))?,
    )?;
    let candidate: serde_json::Value = serde_json::from_reader(
        std::fs::File::open(candidate_path)
            .with_context(|| format!("open candidate {}", candidate_path.display()))?,
    )?;
    let expected = reference
        .get("fixtures")
        .and_then(|value| value.get(0))
        .and_then(|value| value.get("mean_embedding"))
        .or_else(|| reference.get("mean_embedding"))
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("reference has no mean_embedding array"))?;
    let actual = candidate
        .get("embedding")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("candidate has no embedding array"))?;
    let expected = expected
        .iter()
        .map(|value| value.as_f64().map(|value| value as f32))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| anyhow::anyhow!("reference contains a non-numeric embedding"))?;
    let actual = actual
        .iter()
        .map(|value| value.as_f64().map(|value| value as f32))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| anyhow::anyhow!("candidate contains a non-numeric embedding"))?;
    let metrics = compare_vectors(&expected, &actual)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "reference": reference_path,
            "candidate": candidate_path,
            "dimensions": expected.len(),
            "cosine": metrics.cosine,
            "maxAbsError": metrics.max_abs_error,
            "meanAbsError": metrics.mean_abs_error,
            "l2Error": metrics.l2_error,
        }))?
    );
    Ok(())
}

fn frontend_output_size() -> usize {
    256 * 199
}

fn embed_command(
    path: &std::path::Path,
    model_path: &std::path::Path,
    metadata_path: &std::path::Path,
    backend: &str,
    duration: f64,
    raw_output: Option<&std::path::Path>,
) -> Result<()> {
    let started = Instant::now();
    let phase_started = Instant::now();
    let decoded = decode_mono(path, Some(duration))?;
    let samples = resample_to_target(&decoded.samples, decoded.sample_rate, TARGET_SAMPLE_RATE)?;
    let decode_seconds = phase_started.elapsed().as_secs_f64();
    let phase_started = Instant::now();
    let frontend = KapreFrontend::new()?;
    let model = load_embedding_model(backend, model_path, metadata_path)?;
    let model_load_seconds = phase_started.elapsed().as_secs_f64();
    let phase_started = Instant::now();
    let embedding = embed_audio(&samples, &frontend, &model)?;
    let inference_seconds = phase_started.elapsed().as_secs_f64();
    let raw_bytes: Vec<u8> = embedding
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect();
    if let Some(output) = raw_output {
        std::fs::write(output, &raw_bytes)
            .map_err(|error| anyhow::anyhow!("write {}: {error}", output.display()))?;
    }
    let digest = Sha256::digest(&raw_bytes);
    let value = json!({
        "path": path,
        "backend": backend,
        "sourceSampleRate": decoded.sample_rate,
        "sourceSampleCount": decoded.samples.len(),
        "resampledSampleCount": samples.len(),
        "frameCount": frame_count(&samples),
        "embeddingSize": embedding.len(),
        "elapsedSeconds": started.elapsed().as_secs_f64(),
        "decodeSeconds": decode_seconds,
        "modelLoadSeconds": model_load_seconds,
        "inferenceSeconds": inference_seconds,
        "sha256": format!("{digest:x}"),
        "embedding": embedding,
    });
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}

fn decode_command(path: &std::path::Path, duration: f64) -> Result<()> {
    let decoded = decode_mono(path, Some(duration))?;
    let resampled = resample_to_target(&decoded.samples, decoded.sample_rate, TARGET_SAMPLE_RATE)?;
    let source_hash = Sha256::digest(
        resampled
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect::<Vec<_>>(),
    );
    let decoded_hash = Sha256::digest(
        decoded
            .samples
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect::<Vec<_>>(),
    );
    let value = json!({
        "path": path,
        "sourceSampleRate": decoded.sample_rate,
        "sourceSampleCount": decoded.samples.len(),
        "resampledSampleCount": resampled.len(),
        "resampledSha256": format!("{source_hash:x}"),
        "decodedSha256": format!("{decoded_hash:x}"),
        "min": resampled.iter().copied().fold(f32::INFINITY, f32::min),
        "max": resampled.iter().copied().fold(f32::NEG_INFINITY, f32::max),
        "firstSamples": resampled.iter().take(10).copied().collect::<Vec<_>>(),
        "resampler": if cfg!(feature = "soxr-resampler") { "soxr-hq" } else { "linear-fallback" },
    });
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}
