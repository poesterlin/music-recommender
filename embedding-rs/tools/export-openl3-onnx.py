#!/usr/bin/env python3
"""Export the OpenL3 mel256 music network to a frontend-free ONNX artifact.

The Rust implementation owns audio decoding, resampling, framing, and the
Kapre-compatible mel frontend. This script is a build-time conversion helper;
Python is not needed by the resulting worker. It intentionally constructs the
network from the installed OpenL3 package because the upstream .h5 file stores
weights but no serialized Keras architecture.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

import tensorflow as tf
from tensorflow.keras.layers import Flatten, MaxPooling2D
from tensorflow.keras.models import Model

from openl3.models import AUDIO_MODELS


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--metadata", required=True)
    parser.add_argument("--opset", type=int, default=13)
    args = parser.parse_args()

    weights = Path(args.weights).resolve()
    output = Path(args.output).resolve()
    metadata = Path(args.metadata).resolve()
    if not weights.is_file():
        raise SystemExit(f"weights do not exist: {weights}")

    # The upstream model has an input-first BatchNormalization, four blocks of
    # 3x3 convolutions, and a same-padded (32, 24) max pool for 512-D output.
    # Do not include Kapre in this graph: its TensorFlow ops are not portable
    # to tract and the Rust frontend will implement that boundary explicitly.
    network = AUDIO_MODELS["mel256"](include_frontend=False)
    network.load_weights(str(weights))
    pooled = MaxPooling2D(pool_size=(32, 24), padding="same")(network.output)
    model = Model(inputs=network.input, outputs=Flatten()(pooled))

    output.parent.mkdir(parents=True, exist_ok=True)
    import tf2onnx

    model_proto, _ = tf2onnx.convert.from_keras(
        model,
        input_signature=[tf.TensorSpec([None, 256, 199, 1], tf.float32, name="input")],
        opset=args.opset,
        output_path=str(output),
    )

    metadata.parent.mkdir(parents=True, exist_ok=True)
    metadata.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "model": "openl3_audio_mel256_music",
                "artifact": output.name,
                "weights_sha256": sha256(weights),
                "onnx_sha256": sha256(output),
                "opset": args.opset,
                "input_shape": [None, 256, 199, 1],
                "output_shape": [None, 512],
                "frontend": "rust-kapre-mel256",
                "pool_size": [32, 24],
                "notes": "Network-only artifact; audio frontend is implemented in Rust.",
            },
            indent=2,
        )
        + "\n"
    )
    print(
        json.dumps(
            {
                "output": str(output),
                "metadata": str(metadata),
                "input_shape": [None, 256, 199, 1],
                "output_shape": [None, 512],
                "onnx_sha256": sha256(output),
                "model_proto_nodes": len(model_proto.graph.node),
            }
        )
    )


if __name__ == "__main__":
    main()
