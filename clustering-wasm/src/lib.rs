use music_clustering::{benchmark, BenchmarkConfig, BenchmarkReport, Dataset, TrackEmbedding};
use serde::Serialize;
use std::alloc::{alloc, dealloc, Layout};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::slice;

#[derive(Serialize)]
struct BenchmarkPayload {
    report: BenchmarkReport,
    labels: Vec<usize>,
}

#[no_mangle]
pub extern "C" fn wasm_alloc(size: usize) -> *mut u8 {
    if size == 0 {
        return std::ptr::null_mut();
    }
    unsafe { alloc(Layout::from_size_align(size, 8).expect("valid WASM allocation layout")) }
}

#[no_mangle]
pub extern "C" fn wasm_free(ptr: *mut u8, size: usize) {
    if ptr.is_null() || size == 0 {
        return;
    }
    unsafe {
        dealloc(
            ptr,
            Layout::from_size_align(size, 8).expect("valid WASM allocation layout"),
        )
    }
}

unsafe fn expose_output(bytes: Vec<u8>, output_ptr: *mut usize, output_len: *mut usize) -> i32 {
    if output_ptr.is_null() || output_len.is_null() {
        return -1;
    }
    let boxed = bytes.into_boxed_slice();
    let length = boxed.len();
    let pointer = boxed.as_ptr();
    std::mem::forget(boxed);
    *output_ptr = pointer as usize;
    *output_len = length;
    0
}

#[no_mangle]
pub extern "C" fn run_benchmark(
    embedding_ptr: *const f32,
    cluster_ptr: *const i32,
    track_count: usize,
    dimensions: usize,
    k: usize,
    pca_dimensions: usize,
    evaluation_dimensions: usize,
    pca_iterations: usize,
    pca_sample_size: usize,
    runs: usize,
    max_iterations: usize,
    tolerance: f32,
    seed: u64,
    metric_sample_size: usize,
    output_ptr: *mut usize,
    output_len: *mut usize,
) -> i32 {
    let outcome = catch_unwind(AssertUnwindSafe(|| -> Result<Vec<u8>, String> {
        if embedding_ptr.is_null() || track_count == 0 || dimensions == 0 {
            return Err("embedding input is empty".to_string());
        }
        if k == 0 || runs == 0 || max_iterations == 0 {
            return Err("k, runs, and max_iterations must be greater than zero".to_string());
        }
        let input = unsafe { slice::from_raw_parts(embedding_ptr, track_count * dimensions) };
        let mut tracks = Vec::with_capacity(track_count);
        for index in 0..track_count {
            let start = index * dimensions;
            tracks.push(TrackEmbedding {
                uri: String::new(),
                name: String::new(),
                cluster_id: if cluster_ptr.is_null() {
                    None
                } else {
                    Some(unsafe { *cluster_ptr.add(index) })
                },
                embedding: input[start..start + dimensions].to_vec(),
            });
        }
        let dataset = Dataset { tracks };
        let config = BenchmarkConfig {
            k,
            pca_dimensions,
            evaluation_dimensions,
            pca_iterations,
            pca_sample_size,
            runs,
            max_iterations,
            tolerance,
            seed,
            metric_sample_size,
        };
        let result = benchmark(&dataset, &config).map_err(|error| error.to_string())?;
        let report = result.report();
        let labels = result.runs[result.best_run].labels.clone();
        serde_json::to_vec(&BenchmarkPayload { report, labels })
            .map_err(|error| format!("serialize benchmark result: {error}"))
    }));

    let bytes = match outcome {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(error)) => serde_json::to_vec(&serde_json::json!({ "error": error }))
            .unwrap_or_else(|_| b"{\"error\":\"serialization failure\"}".to_vec()),
        Err(_) => b"{\"error\":\"Rust panic in WASM benchmark\"}".to_vec(),
    };
    unsafe { expose_output(bytes, output_ptr, output_len) }
}
