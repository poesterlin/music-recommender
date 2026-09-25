use anyhow::{Context, Result};
use clap::Parser;
use music_clustering::{benchmark, BenchmarkConfig, BenchmarkReport, Dataset, TrackEmbedding};
use postgres::{Client, NoTls};
use serde::Deserialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Parser)]
#[command(
    name = "cluster-bench",
    about = "Benchmark PCA + spherical k-means against the current music clusters",
    long_about = "Reads existing centered embeddings from PostgreSQL. Benchmark mode is read-only; --split-cluster-id records a new assignment generation, and --apply-run-id requires an explicit confirmation and a recorded JSONL artifact."
)]
struct Args {
    /// PostgreSQL URL. Defaults to DATABASE_URL.
    #[arg(long)]
    database_url: Option<String>,

    /// Number of spherical clusters to evaluate.
    #[arg(long, default_value_t = 50)]
    k: usize,

    /// PCA dimensions; use 0 to benchmark directly in the source space.
    #[arg(long, default_value_t = 32)]
    pca_dim: usize,

    /// Fixed dimensions used for quality metrics; use 0 for source space.
    #[arg(long, default_value_t = 32)]
    evaluation_dim: usize,

    /// Power-iteration steps used for each PCA component.
    #[arg(long, default_value_t = 10)]
    pca_iterations: usize,

    /// Number of tracks used to fit PCA.
    #[arg(long, default_value_t = 5_000)]
    pca_sample: usize,

    /// Number of independent spherical k-means runs.
    #[arg(long, default_value_t = 3)]
    runs: usize,

    /// Maximum Lloyd iterations per run.
    #[arg(long, default_value_t = 100)]
    max_iterations: usize,

    /// Centroid movement tolerance for convergence.
    #[arg(long, default_value_t = 0.0001)]
    tolerance: f32,

    /// Base random seed; runs use seed, seed+1, ... .
    #[arg(long, default_value_t = 42)]
    seed: u64,

    /// Optional Rayon worker count for native runs.
    #[arg(long)]
    threads: Option<usize>,

    /// Number of tracks used for the approximate silhouette score.
    #[arg(long, default_value_t = 1_500)]
    metric_sample: usize,

    /// Optionally evaluate only this many deterministically sampled tracks.
    #[arg(long)]
    sample: Option<usize>,

    /// Write the complete JSON report to this path.
    #[arg(long)]
    output: Option<PathBuf>,

    /// Persist a completed benchmark metadata/report row in cluster_run.
    #[arg(long)]
    record_run: bool,

    /// Directory for automatically named reports when --record-run is used.
    #[arg(long)]
    artifact_dir: Option<PathBuf>,

    /// Export the best dry-run assignments as JSONL without touching the DB.
    #[arg(long)]
    assignments: Option<PathBuf>,

    /// Apply a previously recorded assignment artifact to the live track table.
    #[arg(long)]
    apply_run_id: Option<i32>,

    /// Split one existing cluster into two without changing other cluster IDs.
    #[arg(long)]
    split_cluster_id: Option<i32>,

    /// Full JSONL assignment output for --split-cluster-id.
    #[arg(long)]
    split_output: Option<PathBuf>,

    /// JSON split report output; defaults beside --split-output.
    #[arg(long)]
    split_report: Option<PathBuf>,

    /// Number of independent runs for the targeted split.
    #[arg(long, default_value_t = 10)]
    split_runs: usize,

    /// Maximum Lloyd iterations per targeted split run.
    #[arg(long, default_value_t = 100)]
    split_max_iterations: usize,

    /// Centroid movement tolerance for the targeted split.
    #[arg(long, default_value_t = 0.0001)]
    split_tolerance: f32,

    /// Base random seed for the targeted split.
    #[arg(long, default_value_t = 4242)]
    split_seed: u64,

    /// JSONL assignment artifact belonging to --apply-run-id.
    #[arg(long)]
    apply_assignments: Option<PathBuf>,

    /// Required acknowledgement for a live cluster apply.
    #[arg(long)]
    confirm_apply: bool,

    /// Validate an apply artifact and transaction shape without writing.
    #[arg(long)]
    validate_apply: bool,

    /// Restore the assignments and centroids captured by a previous apply.
    #[arg(long)]
    rollback_run_id: Option<i32>,

    /// Required acknowledgement for a live cluster rollback.
    #[arg(long)]
    confirm_rollback: bool,

    /// Validate rollback data without restoring assignments.
    #[arg(long)]
    validate_rollback: bool,
}

#[derive(Debug, Deserialize)]
struct AssignmentArtifact {
    uri: String,
    #[serde(rename = "clusterId")]
    cluster_id: i32,
}

fn read_assignments(path: &Path) -> Result<Vec<AssignmentArtifact>> {
    let file = File::open(path).with_context(|| format!("open {}", path.display()))?;
    let reader = BufReader::new(file);
    let mut assignments = Vec::new();

    for (line_number, line) in reader.lines().enumerate() {
        let line = line.with_context(|| format!("read assignment line {}", line_number + 1))?;
        if line.trim().is_empty() {
            continue;
        }
        let assignment: AssignmentArtifact = serde_json::from_str(&line)
            .with_context(|| format!("parse assignment line {}", line_number + 1))?;
        if assignment.uri.trim().is_empty() {
            anyhow::bail!("assignment line {} has an empty URI", line_number + 1);
        }
        assignments.push(assignment);
    }

    if assignments.is_empty() {
        anyhow::bail!("assignment artifact {} is empty", path.display());
    }
    Ok(assignments)
}

fn load_dataset(database_url: &str, sample_limit: Option<usize>, seed: u64) -> Result<Dataset> {
    let mut client = Client::connect(database_url, NoTls).context("connect to PostgreSQL")?;
    let salt = format!("rust-cluster-bench:{seed}");
    let limit = sample_limit
        .map(i64::try_from)
        .transpose()
        .context("--sample is too large")?;
    let rows = if let Some(limit) = limit {
        let params: &[&(dyn postgres::types::ToSql + Sync)] = &[&salt, &limit];
        client
            .query(
                "SELECT uri, name, cluster_id, embedding_centered::real[] AS embedding \
                 FROM track \
                 WHERE embedding_centered IS NOT NULL \
                   AND embedding_space_version = 1 \
                 ORDER BY md5(uri || $1) \
                 LIMIT $2",
                params,
            )
            .context("read sampled centered embeddings")?
    } else {
        client
            .query(
                "SELECT uri, name, cluster_id, embedding_centered::real[] AS embedding \
                 FROM track \
                 WHERE embedding_centered IS NOT NULL \
                   AND embedding_space_version = 1 \
                 ORDER BY uri",
                &[],
            )
            .context("read centered embeddings")?
    };

    let mut tracks = Vec::with_capacity(rows.len());
    for row in rows {
        let embedding: Vec<f32> = row.get("embedding");
        if embedding.iter().any(|value| !value.is_finite()) {
            anyhow::bail!("non-finite embedding for {}", row.get::<_, String>("uri"));
        }
        tracks.push(TrackEmbedding {
            uri: row.get("uri"),
            name: row.get("name"),
            cluster_id: row.get("cluster_id"),
            embedding,
        });
    }

    Ok(Dataset { tracks })
}

fn write_assignments(path: &Path, dataset: &Dataset, labels: &[usize]) -> Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
    }
    let file = File::create(path).with_context(|| format!("create {}", path.display()))?;
    let mut writer = BufWriter::new(file);
    for (track, &label) in dataset.tracks.iter().zip(labels) {
        let record = json!({
            "uri": track.uri,
            "name": track.name,
            "clusterId": label,
        });
        serde_json::to_writer(&mut writer, &record)?;
        writer.write_all(b"\n")?;
    }
    writer.flush()?;
    Ok(())
}

fn write_report(path: &Path, report: &BenchmarkReport) -> Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
    }
    let file = File::create(path).with_context(|| format!("create {}", path.display()))?;
    let mut writer = BufWriter::new(file);
    serde_json::to_writer_pretty(&mut writer, report)?;
    writer.flush()?;
    Ok(())
}

fn write_json_value(path: &Path, value: &serde_json::Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create {}", parent.display()))?;
        }
    }
    let file = File::create(path).with_context(|| format!("create {}", path.display()))?;
    let mut writer = BufWriter::new(file);
    serde_json::to_writer_pretty(&mut writer, value)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

struct GeneratedRunInput<'a> {
    mode: &'a str,
    config: &'a serde_json::Value,
    report: &'a serde_json::Value,
    report_path: &'a Path,
    assignments_path: &'a Path,
    track_count: usize,
    dimensions: usize,
}

fn record_generated_run(database_url: &str, input: GeneratedRunInput<'_>) -> Result<i64> {
    let GeneratedRunInput {
        mode,
        config,
        report,
        report_path,
        assignments_path,
        track_count,
        dimensions,
    } = input;
    let config_json = serde_json::to_string(config)?;
    let report_json = serde_json::to_string(report)?;
    let report_path = report_path.to_string_lossy().into_owned();
    let assignments_path = assignments_path.to_string_lossy().into_owned();
    let track_count =
        i32::try_from(track_count).context("track count exceeds database integer range")?;
    let dimensions =
        i32::try_from(dimensions).context("dimension count exceeds database integer range")?;
    let mut client =
        Client::connect(database_url, NoTls).context("connect to record generated run")?;
    let row = client
        .query_one(
            "INSERT INTO cluster_run \
             (status, mode, config, report, report_path, assignments_path, track_count, dimensions, completed_at) \
             VALUES ('completed', $1, $2::text::jsonb, $3::text::jsonb, $4, $5, $6, $7, now()) \
             RETURNING id",
            &[
                &mode,
                &config_json,
                &report_json,
                &report_path,
                &assignments_path,
                &track_count,
                &dimensions,
            ],
        )
        .context("record generated run")?;
    Ok(i64::from(row.get::<_, i32>("id")))
}

fn record_cluster_run(
    database_url: &str,
    config: &BenchmarkConfig,
    report: &BenchmarkReport,
    report_path: Option<&Path>,
    assignments_path: Option<&Path>,
    track_count: usize,
    dimensions: usize,
) -> Result<i64> {
    let config_json = serde_json::to_string(config)?;
    let report_json = serde_json::to_string(report)?;
    let report_path = report_path.map(|path| path.to_string_lossy().into_owned());
    let assignments_path = assignments_path.map(|path| path.to_string_lossy().into_owned());
    let track_count =
        i32::try_from(track_count).context("track count exceeds database integer range")?;
    let dimensions =
        i32::try_from(dimensions).context("dimension count exceeds database integer range")?;
    let mut client =
        Client::connect(database_url, NoTls).context("connect to record cluster run")?;
    let row = client
        .query_one(
            "INSERT INTO cluster_run \
             (status, mode, config, report, report_path, assignments_path, track_count, dimensions, completed_at) \
             VALUES ('completed', 'benchmark', $1::text::jsonb, $2::text::jsonb, $3, $4, $5, $6, now()) \
             RETURNING id",
            &[
                &config_json,
                &report_json,
                &report_path,
                &assignments_path,
                &track_count,
                &dimensions,
            ],
        )
        .context("record completed cluster run")?;
    Ok(i64::from(row.get::<_, i32>("id")))
}

struct SplitOptions<'a> {
    cluster_id: i32,
    output_path: &'a Path,
    report_path: &'a Path,
    runs: usize,
    max_iterations: usize,
    tolerance: f32,
    seed: u64,
}

fn split_cluster(database_url: &str, dataset: &Dataset, options: SplitOptions<'_>) -> Result<i64> {
    let SplitOptions {
        cluster_id: split_cluster_id,
        output_path,
        report_path,
        runs,
        max_iterations,
        tolerance,
        seed,
    } = options;
    if split_cluster_id < 0 {
        anyhow::bail!("--split-cluster-id must be non-negative");
    }
    if runs == 0 || max_iterations == 0 {
        anyhow::bail!("--split-runs and --split-max-iterations must be greater than zero");
    }
    let split_tracks: Vec<TrackEmbedding> = dataset
        .tracks
        .iter()
        .filter(|track| track.cluster_id == Some(split_cluster_id))
        .cloned()
        .collect();
    if split_tracks.len() < 2 {
        anyhow::bail!("cluster {split_cluster_id} has fewer than two embedded tracks");
    }
    let local_indices: HashMap<String, usize> = split_tracks
        .iter()
        .enumerate()
        .map(|(index, track)| (track.uri.clone(), index))
        .collect();
    let split_config = BenchmarkConfig {
        k: 2,
        pca_dimensions: 0,
        evaluation_dimensions: 0,
        pca_iterations: 1,
        pca_sample_size: split_tracks.len(),
        runs,
        max_iterations,
        tolerance,
        seed,
        metric_sample_size: split_tracks.len().min(1_500),
    };
    let split_started = Instant::now();
    let split_result = benchmark(
        &Dataset {
            tracks: split_tracks.clone(),
        },
        &split_config,
    )
    .map_err(anyhow::Error::msg)?;
    let best = &split_result.runs[split_result.best_run];
    let mut labels = best.labels.clone();
    let mut first_uri = [None::<String>, None::<String>];
    for (track, label) in split_tracks.iter().zip(labels.iter()) {
        let slot = &mut first_uri[*label];
        if slot
            .as_ref()
            .map(|value| track.uri < *value)
            .unwrap_or(true)
        {
            *slot = Some(track.uri.clone());
        }
    }
    if first_uri[1]
        .as_ref()
        .is_some_and(|right| first_uri[0].as_ref().is_some_and(|left| right < left))
    {
        for label in &mut labels {
            *label = 1 - *label;
        }
    }

    let current_max = dataset
        .tracks
        .iter()
        .filter_map(|track| track.cluster_id)
        .max()
        .context("dataset has no cluster ids")?;
    let new_cluster_id = current_max
        .checked_add(1)
        .context("cluster id space exhausted")?;
    let final_k = new_cluster_id
        .checked_add(1)
        .context("cluster count overflow")?;
    let mut full_labels = Vec::with_capacity(dataset.tracks.len());
    for track in &dataset.tracks {
        let old_id = track
            .cluster_id
            .context("embedded track has no cluster id")?;
        if old_id == split_cluster_id {
            let local_index = local_indices
                .get(&track.uri)
                .context("split track disappeared from local index")?;
            full_labels.push(if labels[*local_index] == 0 {
                split_cluster_id as usize
            } else {
                new_cluster_id as usize
            });
        } else {
            full_labels.push(old_id as usize);
        }
    }

    write_assignments(output_path, dataset, &full_labels)?;
    let split_counts = [
        labels.iter().filter(|label| **label == 0).count(),
        labels.iter().filter(|label| **label == 1).count(),
    ];
    let mut client =
        Client::connect(database_url, NoTls).context("connect to identify parent run")?;
    let parent_run_id: i32 = client
        .query_one(
            "SELECT id FROM cluster_run WHERE status = 'applied' \
             ORDER BY applied_at DESC NULLS LAST, id DESC LIMIT 1",
            &[],
        )
        .context("find active parent cluster run")?
        .get("id");
    let config = json!({
        "k": final_k,
        "mode": "split",
        "source_run_id": parent_run_id,
        "source_cluster_id": split_cluster_id,
        "new_cluster_id": new_cluster_id,
        "split_runs": runs,
        "split_seed": seed,
        "split_max_iterations": max_iterations,
        "split_tolerance": tolerance,
    });
    let report = json!({
        "kind": "targeted_cluster_split",
        "source_run_id": parent_run_id,
        "source_cluster_id": split_cluster_id,
        "new_cluster_id": new_cluster_id,
        "final_k": final_k,
        "track_count": dataset.tracks.len(),
        "split_track_count": split_tracks.len(),
        "subcluster_counts": {
            split_cluster_id.to_string(): split_counts[0],
            new_cluster_id.to_string(): split_counts[1],
        },
        "seed": seed,
        "runs": runs,
        "best_run": split_result.best_run,
        "best_seed": best.seed,
        "iterations": best.iterations,
        "converged": best.converged,
        "inertia": best.training_inertia,
        "duration_seconds": split_started.elapsed().as_secs_f64(),
    });
    write_json_value(report_path, &report)?;
    let run_id = record_generated_run(
        database_url,
        GeneratedRunInput {
            mode: "split",
            config: &config,
            report: &report,
            report_path,
            assignments_path: output_path,
            track_count: dataset.tracks.len(),
            dimensions: dataset.dimensions().map_err(anyhow::Error::msg)?,
        },
    )?;
    println!(
        "Recorded split run #{run_id}: split cluster {split_cluster_id} ({}) into {split_cluster_id}/{new_cluster_id} ({}), final k={final_k}.",
        split_tracks.len(),
        split_counts[1]
    );
    println!("Assignments: {}", output_path.display());
    println!("Report: {}", report_path.display());
    Ok(run_id)
}

fn parse_run_k(config_text: &str) -> Result<i32> {
    let config: serde_json::Value =
        serde_json::from_str(config_text).context("parse cluster run configuration")?;
    let k = config
        .get("k")
        .and_then(serde_json::Value::as_u64)
        .context("cluster run configuration has no k value")?;
    i32::try_from(k).context("cluster run k exceeds database integer range")
}

fn apply_recorded_run(
    database_url: &str,
    run_id: i32,
    path: &Path,
    confirmed: bool,
    validate_only: bool,
) -> Result<()> {
    if !confirmed && !validate_only {
        anyhow::bail!("live apply requires --confirm-apply");
    }
    if run_id < 1 {
        anyhow::bail!("--apply-run-id must be greater than zero");
    }

    let assignments = read_assignments(path)?;
    let mut client =
        Client::connect(database_url, NoTls).context("connect to apply cluster run")?;
    let mut tx = client.transaction()?;
    let lock_key: i64 = 918_273_645;
    tx.query_one("SELECT pg_advisory_xact_lock($1)", &[&lock_key])
        .context("lock cluster apply")?;

    let run = tx
        .query_one(
            "SELECT status, mode, COALESCE(track_count, 0) AS track_count, \
                    COALESCE(dimensions, 0) AS dimensions, config::text AS config_text, \
                    assignments_path \
             FROM cluster_run WHERE id = $1",
            &[&run_id],
        )
        .context("load cluster run for apply")?;
    let status: String = run.get("status");
    let mode: String = run.get("mode");
    let run_track_count: i32 = run.get("track_count");
    let dimensions: i32 = run.get("dimensions");
    let config_text: String = run.get("config_text");
    let expected_path: Option<String> = run.get("assignments_path");

    if status != "completed" {
        anyhow::bail!("cluster run {run_id} is not completed (status: {status})");
    }
    if mode != "benchmark" && mode != "split" {
        anyhow::bail!("cluster run {run_id} has unsupported mode {mode}");
    }
    if dimensions != 512 {
        anyhow::bail!("cluster run {run_id} has dimensions {dimensions}, expected 512");
    }
    let k = parse_run_k(&config_text)?;
    if k < 1 {
        anyhow::bail!("cluster run {run_id} has invalid k={k}");
    }
    let expected_path = expected_path
        .filter(|value| !value.trim().is_empty())
        .context("cluster run has no linked assignments artifact")?;
    if Path::new(&expected_path).file_name() != path.file_name() {
        anyhow::bail!(
            "assignment artifact does not match cluster run {run_id}: expected {}, got {}",
            expected_path,
            path.display()
        );
    }

    let mut seen_uris = HashSet::with_capacity(assignments.len());
    for assignment in &assignments {
        if !seen_uris.insert(assignment.uri.clone()) {
            anyhow::bail!("duplicate URI in assignment artifact: {}", assignment.uri);
        }
        if assignment.cluster_id < 0 || assignment.cluster_id >= k {
            anyhow::bail!(
                "URI {} has cluster id {}, outside 0..{}",
                assignment.uri,
                assignment.cluster_id,
                k - 1
            );
        }
    }
    if assignments.len() != run_track_count as usize {
        anyhow::bail!(
            "assignment artifact has {} rows, but cluster run recorded {} tracks",
            assignments.len(),
            run_track_count
        );
    }

    let input = assignments
        .iter()
        .map(|assignment| {
            json!({
                "uri": assignment.uri,
                "cluster_id": assignment.cluster_id,
            })
        })
        .collect::<Vec<_>>();
    let input_json = serde_json::to_string(&input)?;

    let existing: i64 = tx
        .query_one(
            "SELECT count(*)::bigint FROM cluster_run_assignment WHERE run_id = $1",
            &[&run_id],
        )
        .context("check existing applied assignment audit")?
        .get(0);
    if existing != 0 {
        anyhow::bail!("cluster run {run_id} already has assignment audit rows");
    }

    let counts = tx.query_one(
        "SELECT count(*)::bigint AS total, \
                count(*) FILTER (WHERE embedding_centered IS NOT NULL AND embedding_space_version = 1)::bigint AS eligible \
         FROM track",
        &[],
    )?;
    let total_tracks: i64 = counts.get("total");
    let eligible_tracks: i64 = counts.get("eligible");
    if eligible_tracks != run_track_count as i64 {
        anyhow::bail!(
            "live library has {total_tracks} total tracks ({eligible_tracks} embedded), but run {run_id} recorded {run_track_count}; unembedded wildcard tracks are left untouched"
        );
    }

    tx.query(
        "CREATE TEMP TABLE cluster_apply_input (\
             uri text PRIMARY KEY,\
             cluster_id integer NOT NULL\
         ) ON COMMIT DROP",
        &[],
    )?;
    tx.query(
        "INSERT INTO cluster_apply_input (uri, cluster_id) \
         SELECT x.uri, x.cluster_id \
         FROM jsonb_to_recordset($1::text::jsonb) AS x(uri text, cluster_id integer)",
        &[&input_json],
    )?;

    let input_count: i64 = tx
        .query_one("SELECT count(*)::bigint FROM cluster_apply_input", &[])?
        .get(0);
    let distinct_clusters: i64 = tx
        .query_one(
            "SELECT count(DISTINCT cluster_id)::bigint FROM cluster_apply_input",
            &[],
        )?
        .get(0);
    let matched_tracks: i64 = tx
        .query_one(
            "SELECT count(*)::bigint \
             FROM track t JOIN cluster_apply_input i ON i.uri = t.uri \
             WHERE t.embedding_centered IS NOT NULL AND t.embedding_space_version = 1",
            &[],
        )?
        .get(0);
    if input_count != run_track_count as i64
        || distinct_clusters != k as i64
        || matched_tracks != run_track_count as i64
    {
        anyhow::bail!(
            "assignment validation failed: input={input_count}, distinct_clusters={distinct_clusters}, matched_tracks={matched_tracks}, expected_tracks={run_track_count}, k={k}"
        );
    }
    if validate_only {
        drop(tx);
        println!(
            "Validated cluster run #{run_id}: {} assignments across k={k}; no database changes were made.",
            assignments.len()
        );
        return Ok(());
    }

    tx.query(
        "INSERT INTO cluster_run_assignment \
             (run_id, uri, cluster_id, previous_cluster_id) \
         SELECT $1, i.uri, i.cluster_id, t.cluster_id \
         FROM cluster_apply_input i JOIN track t ON t.uri = i.uri",
        &[&run_id],
    )?;
    tx.query(
        "INSERT INTO cluster_centroid_backup \
             (run_id, cluster_id, embedding, track_count, embedding_space_version) \
         SELECT $1, cluster_id, embedding, track_count, embedding_space_version \
         FROM cluster_centroid",
        &[&run_id],
    )?;

    let changed = tx.execute(
        "UPDATE track t \
         SET cluster_id = i.cluster_id, updated_at = now() \
         FROM cluster_apply_input i \
         WHERE t.uri = i.uri",
        &[],
    )?;
    if changed != assignments.len() as u64 {
        anyhow::bail!("updated {changed} tracks, expected {}", assignments.len());
    }

    let centroids = tx.query(
        "INSERT INTO cluster_centroid \
             (cluster_id, embedding, track_count, embedding_space_version, updated_at) \
         SELECT i.cluster_id, \
                normalize_cluster_embedding(avg(t.embedding_centered)::vector), \
                count(*)::integer, 1, now() \
         FROM cluster_apply_input i JOIN track t ON t.uri = i.uri \
         GROUP BY i.cluster_id \
         ON CONFLICT (cluster_id) DO UPDATE SET \
             embedding = EXCLUDED.embedding, \
             track_count = EXCLUDED.track_count, \
             embedding_space_version = EXCLUDED.embedding_space_version, \
             updated_at = EXCLUDED.updated_at \
         RETURNING cluster_id",
        &[],
    )?;
    if centroids.len() != k as usize {
        anyhow::bail!("created {} centroids, expected {k}", centroids.len());
    }
    tx.execute("DELETE FROM cluster_centroid WHERE cluster_id >= $1", &[&k])?;
    tx.execute(
        "UPDATE cluster_run SET status = 'applied', applied_at = now() WHERE id = $1",
        &[&run_id],
    )?;

    tx.commit()?;
    println!(
        "Applied cluster run #{run_id}: {} tracks across k={k}; centroids rebuilt. Previous assignments and centroids were retained for rollback.",
        assignments.len()
    );
    Ok(())
}

fn rollback_recorded_run(
    database_url: &str,
    run_id: i32,
    confirmed: bool,
    validate_only: bool,
) -> Result<()> {
    if !confirmed && !validate_only {
        anyhow::bail!("rollback requires --confirm-rollback");
    }
    let mut client =
        Client::connect(database_url, NoTls).context("connect to rollback cluster run")?;
    let mut tx = client.transaction()?;
    let lock_key: i64 = 918_273_645;
    tx.query_one("SELECT pg_advisory_xact_lock($1)", &[&lock_key])
        .context("lock cluster rollback")?;

    let run = tx
        .query_one(
            "SELECT status, mode FROM cluster_run WHERE id = $1",
            &[&run_id],
        )
        .context("load cluster run for rollback")?;
    let status: String = run.get("status");
    let mode: String = run.get("mode");
    if status != "applied" || (mode != "benchmark" && mode != "split") {
        anyhow::bail!(
            "cluster run {run_id} is not an applied benchmark or split (status: {status})"
        );
    }

    let assignment_count: i64 = tx
        .query_one(
            "SELECT count(*)::bigint FROM cluster_run_assignment WHERE run_id = $1",
            &[&run_id],
        )?
        .get(0);
    let null_previous: i64 = tx
        .query_one(
            "SELECT count(*)::bigint FROM cluster_run_assignment \
             WHERE run_id = $1 AND previous_cluster_id IS NULL",
            &[&run_id],
        )?
        .get(0);
    let centroid_count: i64 = tx
        .query_one(
            "SELECT count(*)::bigint FROM cluster_centroid_backup WHERE run_id = $1",
            &[&run_id],
        )?
        .get(0);
    let current_counts = tx.query_one(
        "SELECT count(*)::bigint AS total, \
                count(*) FILTER (WHERE embedding_centered IS NOT NULL AND embedding_space_version = 1)::bigint AS eligible \
         FROM track",
        &[],
    )?;
    let current_count: i64 = current_counts.get("total");
    let current_eligible: i64 = current_counts.get("eligible");
    if assignment_count == 0
        || centroid_count == 0
        || null_previous != 0
        || current_eligible != assignment_count
    {
        anyhow::bail!(
            "rollback validation failed: assignments={assignment_count}, centroids={centroid_count}, null_previous={null_previous}, current_tracks={current_count}, current_embedded={current_eligible}"
        );
    }
    if validate_only {
        drop(tx);
        println!(
            "Validated rollback for cluster run #{run_id}: {assignment_count} assignments and {centroid_count} centroids are available; no database changes were made."
        );
        return Ok(());
    }

    let changed = tx.execute(
        "UPDATE track t \
         SET cluster_id = a.previous_cluster_id, updated_at = now() \
         FROM cluster_run_assignment a \
         WHERE a.run_id = $1 AND t.uri = a.uri",
        &[&run_id],
    )?;
    if changed != assignment_count as u64 {
        anyhow::bail!("restored {changed} assignments, expected {assignment_count}");
    }
    tx.execute("DELETE FROM cluster_centroid", &[])?;
    tx.query(
        "INSERT INTO cluster_centroid \
             (cluster_id, embedding, track_count, embedding_space_version, updated_at) \
         SELECT cluster_id, embedding, track_count, embedding_space_version, now() \
         FROM cluster_centroid_backup WHERE run_id = $1",
        &[&run_id],
    )?;
    tx.execute(
        "UPDATE cluster_run SET status = 'rolled_back' WHERE id = $1",
        &[&run_id],
    )?;

    tx.commit()?;
    println!("Rolled back cluster run #{run_id}; previous assignments and centroids restored.");
    Ok(())
}

fn main() -> Result<()> {
    let args = Args::parse();
    let database_url = args
        .database_url
        .or_else(|| env::var("DATABASE_URL").ok())
        .context("pass --database-url or set DATABASE_URL")?;

    if args.apply_run_id.is_some() || args.rollback_run_id.is_some() {
        if args.apply_run_id.is_some() && args.rollback_run_id.is_some() {
            anyhow::bail!("choose either --apply-run-id or --rollback-run-id");
        }
        if let Some(run_id) = args.apply_run_id {
            let path = args
                .apply_assignments
                .as_deref()
                .context("--apply-run-id requires --apply-assignments")?;
            return apply_recorded_run(
                &database_url,
                run_id,
                path,
                args.confirm_apply,
                args.validate_apply,
            );
        }
        if let Some(run_id) = args.rollback_run_id {
            return rollback_recorded_run(
                &database_url,
                run_id,
                args.confirm_rollback,
                args.validate_rollback,
            );
        }
    }
    if args.apply_assignments.is_some()
        || args.confirm_apply
        || args.validate_apply
        || args.confirm_rollback
        || args.validate_rollback
    {
        anyhow::bail!("apply/rollback confirmation flags require a run id");
    }
    if args.split_cluster_id.is_none()
        && (args.split_output.is_some() || args.split_report.is_some())
    {
        anyhow::bail!("split output options require --split-cluster-id");
    }

    if args.sample == Some(0) {
        anyhow::bail!("--sample must be greater than zero");
    }
    #[cfg(feature = "rayon")]
    if let Some(threads) = args.threads {
        if threads == 0 {
            anyhow::bail!("--threads must be greater than zero");
        }
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build_global()
            .context("configure Rayon thread pool")?;
    }
    #[cfg(not(feature = "rayon"))]
    if args.threads.is_some() {
        anyhow::bail!("--threads requires the native rayon feature");
    }

    let load_started = Instant::now();
    let dataset = load_dataset(&database_url, args.sample, args.seed)?;
    let dimensions = dataset.dimensions().map_err(anyhow::Error::msg)?;
    println!(
        "Loaded {} tracks × {} dimensions from PostgreSQL in {:.2}s (read-only).",
        dataset.tracks.len(),
        dimensions,
        load_started.elapsed().as_secs_f64()
    );

    if let Some(split_cluster_id) = args.split_cluster_id {
        let output_path = args
            .split_output
            .as_deref()
            .context("--split-cluster-id requires --split-output")?;
        let report_path = args
            .split_report
            .clone()
            .unwrap_or_else(|| output_path.with_extension("split-report.json"));
        split_cluster(
            &database_url,
            &dataset,
            SplitOptions {
                cluster_id: split_cluster_id,
                output_path,
                report_path: &report_path,
                runs: args.split_runs,
                max_iterations: args.split_max_iterations,
                tolerance: args.split_tolerance,
                seed: args.split_seed,
            },
        )?;
        return Ok(());
    }

    let config = BenchmarkConfig {
        k: args.k,
        pca_dimensions: args.pca_dim,
        evaluation_dimensions: args.evaluation_dim,
        pca_iterations: args.pca_iterations,
        pca_sample_size: args.pca_sample,
        runs: args.runs,
        max_iterations: args.max_iterations,
        tolerance: args.tolerance,
        seed: args.seed,
        metric_sample_size: args.metric_sample,
    };

    let benchmark_started = Instant::now();
    let result = benchmark(&dataset, &config).map_err(anyhow::Error::msg)?;
    println!(
        "Benchmarked {} spherical-kmeans run{} in {:.2}s.",
        result.runs.len(),
        if result.runs.len() == 1 { "" } else { "s" },
        benchmark_started.elapsed().as_secs_f64()
    );

    println!(
        "Training features: {}-dimensional {} PCA (fit sample: {}).",
        result.pca.output_dimensions,
        if result.pca.applied { "applied" } else { "not" },
        result.pca.sample_size
    );
    println!(
        "Evaluation features: {}-dimensional {} PCA.",
        result.evaluation_pca.output_dimensions,
        if result.evaluation_pca.applied {
            "applied"
        } else {
            "not"
        }
    );
    if let Some(current) = &result.current_assignments {
        println!(
            "Current: mean intra-similarity {:.4}, silhouette {}",
            current.mean_intra_similarity,
            current
                .silhouette
                .map(|value| format!("{value:.4}"))
                .unwrap_or_else(|| "n/a".to_string())
        );
    }

    let report = result.report();
    if result.runs.len() > 1 {
        println!(
            "Pairwise run ARI: mean {}, minimum {}.",
            report
                .mean_pairwise_ari
                .map(|value| format!("{value:.4}"))
                .unwrap_or_else(|| "n/a".to_string()),
            report
                .min_pairwise_ari
                .map(|value| format!("{value:.4}"))
                .unwrap_or_else(|| "n/a".to_string())
        );
    }

    for (index, run) in result.runs.iter().enumerate() {
        println!(
            "Run {} (seed {}): training inertia {:.2}, evaluation inertia {:.2}, intra {:.4}, silhouette {}, iterations {}{}.",
            index + 1,
            run.seed,
            run.training_inertia,
            run.metrics.inertia,
            run.metrics.mean_intra_similarity,
            run.metrics
                .silhouette
                .map(|value| format!("{value:.4}"))
                .unwrap_or_else(|| "n/a".to_string()),
            run.iterations,
            if run.converged { ", converged" } else { "" }
        );
    }

    let report_path = if args.record_run {
        let path = args.output.clone().unwrap_or_else(|| {
            let directory = args
                .artifact_dir
                .clone()
                .unwrap_or_else(|| PathBuf::from("artifacts"));
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            directory.join(format!("cluster-run-{stamp}.json"))
        });
        write_report(&path, &report)?;
        println!("Wrote report to {}.", path.display());
        Some(path)
    } else if let Some(path) = args.output.clone() {
        write_report(&path, &report)?;
        println!("Wrote report to {}.", path.display());
        Some(path)
    } else {
        println!("\n{}", serde_json::to_string_pretty(&report)?);
        None
    };

    let assignments_path = if let Some(path) = args.assignments.clone() {
        write_assignments(&path, &dataset, &result.runs[result.best_run].labels)?;
        println!(
            "Wrote dry-run assignments to {}; database was not modified.",
            path.display()
        );
        Some(path)
    } else {
        None
    };

    if args.record_run {
        let run_id = record_cluster_run(
            &database_url,
            &config,
            &report,
            report_path.as_deref(),
            assignments_path.as_deref(),
            dataset.tracks.len(),
            dimensions,
        )?;
        println!("Recorded completed cluster run #{run_id}.");
    }

    Ok(())
}
