#!/usr/bin/env python3
"""Portable entrypoint for the authenticated API-mode embedding worker.

This wrapper loads ``generate-local-embeddings.py`` by path because that legacy
filename is not a valid Python import name.  The loaded module is passed back
to its dispatcher, which hands the module itself to the API implementation so
all existing audio/OpenL3 core functions are reused.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import Sequence


CORE_PATH = Path(__file__).with_name("generate-local-embeddings.py")
CORE_MODULE_NAME = "music_recommender_local_embeddings"
_EMBEDDINGS_DIR = str(Path(__file__).resolve().parent)
if _EMBEDDINGS_DIR not in sys.path:
    sys.path.insert(0, _EMBEDDINGS_DIR)


def load_core_module(
    path: str | Path = CORE_PATH, *, module_name: str = CORE_MODULE_NAME
) -> ModuleType:
    """Load the hyphenated legacy script as a normal Python module."""

    script_path = Path(path)
    sibling = str(script_path.parent)
    if sibling not in sys.path:
        sys.path.insert(0, sibling)
    spec = importlib.util.spec_from_file_location(module_name, script_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"could not load embedding core from {script_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def get_core_module() -> ModuleType:
    """Return the loaded core module, loading it on first use."""

    module = globals().get("core")
    if isinstance(module, ModuleType):
        return module
    module = load_core_module()
    globals()["core"] = module
    return module


def main(argv: Sequence[str] | None = None) -> int:
    # The dedicated wrapper is intentionally API-first.  The legacy script
    # remains local-first when invoked directly, preserving its deployment.
    return int(get_core_module().main(argv, default_source_mode="api"))


__all__ = ["CORE_PATH", "get_core_module", "load_core_module", "main"]


if __name__ == "__main__":
    raise SystemExit(main())
