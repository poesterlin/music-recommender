use std::fmt::Write as _;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use postgres::{Client, NoTls};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::audio::decode_mono;
use crate::backend::{load_embedding_model, InferenceModel};
use crate::db::{self, TrackRow};
use crate::file_index::{build_audio_index, TrackMetadata};
use crate::framing::frame_count;
use crate::frontend::KapreFrontend;
use crate::resample::resample_to_target;
use crate::TARGET_SAMPLE_RATE;

#[derive(Clone, Debug)]
pub struct WorkerArgs {
    pub database_url: String,
    pub audio_dir: PathBuf,
    pub backend: String,
    pub model_path: PathBuf,
    pub metadata_path: PathBuf,
    pub batch_size: usize,
    pub limit: Option<usize>,
    pub uri_filter: Option<String>,
    pub duration_seconds: f64,
    pub write: bool,
    pub confirm_write: bool,
    pub fail_fast: bool,
    pub max_errors: Option<usize>,
    pub report_path: Option<PathBuf>,
    pub include_vector: bool,
    pub expected_space_version: i32,
    pub expected_model: String,
}

struct PendingEmbedding {
    track: TrackRow,
    path: PathBuf,
    frame_count: usize,
    vector: Vec<f32>,
    vector_sha256: String,
}

pub fn run(args: WorkerArgs) -> Result<()> {
    if args.write && !args.confirm_write {
        bail!("--write requires --confirm-write");
    }
    if args.batch_size == 0 || args.batch_size > 512 {
        bail!("--batch-size must be between 1 and 512");
    }
    if args.duration_seconds <= 0.0 || !args.duration_seconds.is_finite() {
        bail!("--duration must be a positive finite number");
    }
    if args.max_errors == Some(0) {
        bail!("--max-errors must be positive when provided");
    }
    if args.write {
        eprintln!(
            "embedding write mode enabled for model {}; only rows with embedding IS NULL will be touched",
            args.model_path.display()
        );
    } else {
        eprintln!("embedding dry-run mode; no database rows will be changed");
    }

    let model = load_embedding_model(&args.backend, &args.model_path, &args.metadata_path)?;
    let frontend = KapreFrontend::new()?;
    let index = build_audio_index(&args.audio_dir)
        .with_context(|| format!("build audio index from {}", args.audio_dir.display()))?;
    eprintln!(
        "indexed {} filename keys from {}",
        index.len(),
        args.audio_dir.display()
    );

    let mut client = Client::connect(&args.database_url, NoTls).context("connect to PostgreSQL")?;
    let space = db::preflight(
        &mut client,
        args.expected_space_version,
        &args.expected_model,
    )?;
    eprintln!(
        "preflight ok: model={} version={} tracks={}",
        space.model, space.version, space.track_count
    );

    let mut report = match args.report_path.as_ref() {
        Some(path) => {
            if let Some(parent) = path.parent() {
                if !parent.as_os_str().is_empty() {
                    std::fs::create_dir_all(parent)
                        .with_context(|| format!("create report directory {}", parent.display()))?;
                }
            }
            Some(BufWriter::new(File::create(path).with_context(|| {
                format!("create report {}", path.display())
            })?))
        }
        None => None,
    };

    let mut after = None;
    let mut examined = 0_usize;
    let mut embedded = 0_usize;
    let mut failed = 0_usize;
    let mut written = 0_usize;

    'pages: loop {
        let page = db::fetch_unembedded_page(&mut client, after.as_deref(), args.batch_size as i64)
            .context("read unembedded tracks")?;
        if page.is_empty() {
            break;
        }
        let last_uri = page.last().map(|track| track.uri.clone());
        let mut pending = Vec::new();

        for track in page {
            if let Some(limit) = args.limit {
                if examined >= limit {
                    break;
                }
            }
            if let Some(filter) = &args.uri_filter {
                if &track.uri != filter {
                    continue;
                }
            }
            examined += 1;
            let metadata = TrackMetadata {
                name: track.name.clone(),
                artists: track.artists.clone(),
                album: track.album.clone(),
            };
            let Some(path) = index.find(&metadata).map(Path::to_path_buf) else {
                failed += 1;
                write_report(
                    &mut report,
                    json!({
                        "uri": track.uri,
                        "status": "not_found",
                        "name": track.name,
                    }),
                )?;
                if args.fail_fast {
                    bail!("no local audio found for {}", track.uri);
                }
                if args.max_errors.is_some_and(|limit| failed >= limit) {
                    break 'pages;
                }
                continue;
            };

            match embed_track(&model, &frontend, &path, args.duration_seconds) {
                Ok(result) => {
                    let vector_sha256 = sha256_f32(&result.vector);
                    let record = json!({
                        "uri": track.uri,
                        "status": if args.write { "ready_to_write" } else { "dry_run" },
                        "path": path,
                        "frameCount": result.frame_count,
                        "embeddingSize": result.vector.len(),
                        "embeddingSha256": vector_sha256,
                        "embedding": if args.include_vector { json!(result.vector) } else { serde_json::Value::Null },
                    });
                    if !args.write {
                        write_report(&mut report, record)?;
                    }
                    pending.push(PendingEmbedding {
                        track,
                        path,
                        frame_count: result.frame_count,
                        vector: result.vector,
                        vector_sha256,
                    });
                    embedded += 1;
                }
                Err(error) => {
                    failed += 1;
                    write_report(
                        &mut report,
                        json!({
                            "uri": track.uri,
                            "status": "error",
                            "path": path,
                            "error": error.to_string(),
                        }),
                    )?;
                    if args.fail_fast {
                        return Err(error);
                    }
                    if args.max_errors.is_some_and(|limit| failed >= limit) {
                        break 'pages;
                    }
                }
            }
        }

        if args.write && !pending.is_empty() {
            let count = apply_batch(&mut client, &pending, args.expected_space_version)?;
            written += count;
            for item in &pending {
                let mut record = json!({
                    "uri": item.track.uri,
                    "status": "written",
                    "path": item.path,
                    "frameCount": item.frame_count,
                    "embeddingSha256": item.vector_sha256,
                });
                if args.include_vector {
                    record["embedding"] = json!(item.vector);
                }
                write_report(&mut report, record)?;
            }
        }

        after = last_uri;
        if args.limit.is_some_and(|limit| examined >= limit) {
            break;
        }
    }

    if let Some(writer) = report.as_mut() {
        writer.flush().context("flush embedding report")?;
    }
    eprintln!(
        "embedding summary: examined={} embedded={} failed={} written={}",
        examined, embedded, failed, written
    );
    Ok(())
}

struct EmbedResult {
    frame_count: usize,
    vector: Vec<f32>,
}

fn embed_track(
    model: &InferenceModel,
    frontend: &KapreFrontend,
    path: &Path,
    duration_seconds: f64,
) -> Result<EmbedResult> {
    let decoded = decode_mono(path, Some(duration_seconds))?;
    let samples = resample_to_target(&decoded.samples, decoded.sample_rate, TARGET_SAMPLE_RATE)?;
    let count = frame_count(&samples);
    let vector = crate::embed::embed_audio(&samples, frontend, model)?;
    Ok(EmbedResult {
        frame_count: count,
        vector,
    })
}

fn apply_batch(
    client: &mut Client,
    pending: &[PendingEmbedding],
    expected_version: i32,
) -> Result<usize> {
    let mut transaction = client
        .transaction()
        .context("begin embedding transaction")?;
    transaction
        .batch_execute("LOCK TABLE public.embedding_space IN SHARE MODE")
        .context("lock embedding space for write")?;
    let active_version: i32 = transaction
        .query_one(
            "SELECT version FROM public.embedding_space ORDER BY version DESC LIMIT 1",
            &[],
        )
        .context("recheck embedding space in transaction")?
        .get(0);
    if active_version != expected_version {
        bail!(
            "embedding space changed during processing: active version {}",
            active_version
        );
    }

    for item in pending {
        let vector = vector_literal(&item.vector)?;
        let row = transaction
            .query_opt(
                "UPDATE public.track
                 SET embedding = $1::vector, updated_at = NOW()
                 WHERE uri = $2
                   AND embedding IS NULL
                   AND (skip IS NULL OR skip = FALSE)
                   AND name = $3
                   AND artist = $4
                   AND album = $5
                 RETURNING embedding_space_version,
                           embedding_centered IS NULL AS centered_is_null",
                &[
                    &vector,
                    &item.track.uri,
                    &item.track.name,
                    &item.track.artists,
                    &item.track.album,
                ],
            )
            .with_context(|| format!("update embedding for {}", item.track.uri))?;
        let Some(row) = row else {
            bail!("track changed or is no longer eligible: {}", item.track.uri);
        };
        let version: Option<i32> = row.get(0);
        let centered_is_null: bool = row.get(1);
        if version != Some(expected_version) {
            bail!(
                "unexpected embedding-space version for {}: {:?}",
                item.track.uri,
                version
            );
        }
        if centered_is_null {
            bail!(
                "centering trigger produced a null centered vector for {}",
                item.track.uri
            );
        }
    }
    transaction
        .commit()
        .context("commit embedding transaction")?;
    Ok(pending.len())
}

fn vector_literal(values: &[f32]) -> Result<String> {
    if values.is_empty() || values.iter().any(|value| !value.is_finite()) {
        bail!("embedding vector is empty or non-finite");
    }
    let mut output = String::with_capacity(values.len() * 12 + 2);
    output.push('[');
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        write!(&mut output, "{value:.8}")?;
    }
    output.push(']');
    Ok(output)
}

fn sha256_f32(values: &[f32]) -> String {
    let digest = Sha256::digest(
        values
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect::<Vec<_>>(),
    );
    format!("{digest:x}")
}

fn write_report(writer: &mut Option<BufWriter<File>>, value: serde_json::Value) -> Result<()> {
    let line = serde_json::to_string(&value)?;
    println!("{line}");
    if let Some(writer) = writer {
        writeln!(writer, "{line}")?;
    }
    Ok(())
}
