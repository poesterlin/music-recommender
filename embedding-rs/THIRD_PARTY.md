# Third-party model notes

The runtime uses the OpenL3 `mel256` music network and the upstream OpenL3
weights. OpenL3 is distributed under the MIT license. The development exporter
uses TensorFlow/Keras, Kapre, and `tf2onnx` only to create the ONNX artifact;
none of those Python packages are included in the Rust runtime image.

Reference: [OpenL3 repository](https://github.com/marl/openl3) and the OpenL3
paper, *OpenL3: A Competitive and Open Deep Audio Embedding* (2019).

The runtime also uses native libsndfile and libsoxr for decoder/resampler
parity, with ffmpeg as a container fallback for M4A/audioread-compatible
files. These are runtime audio dependencies, not a Python runtime.

The optional `onnxruntime` feature uses the `ort` Rust bindings and the
ONNX Runtime CPU runtime (ONNX Runtime is MIT licensed). The production build
uses the static CPU archive downloaded and hash-verified by `ort-sys`; the
runtime image still needs the system `libstdc++6` package. The default tract
backend does not require the ONNX Runtime archive.

The binary artifact is intentionally kept outside Git. Keep
`model-lock.json` and the artifact together, and verify the SHA-256 before
starting the worker.
