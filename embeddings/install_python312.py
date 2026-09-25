#!/usr/bin/env python3
"""Install the pinned OpenL3 stack on Python 3.12+.

OpenL3 0.4.2 and resampy 0.2.2 are source distributions whose setup.py files
import the removed stdlib ``imp`` module. This helper verifies the exact
upstream archives, applies a packaging-only compatibility patch in a temporary
directory, and installs the patched distributions. Model code and versions are
not changed.
"""

from __future__ import annotations

import hashlib
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

OPENL3 = {
    "name": "openl3",
    "version": "0.4.2",
    "url": "https://files.pythonhosted.org/packages/33/fb/ac93a879d93db231e9f94acf2b07ac0977290f746953dd014ba7f1ac68b5/openl3-0.4.2.tar.gz",
    "sha256": "bd590f6c311de5196b615b65a3f49ea1327be72ed6e9e3cddb5631e391c1ee8a",
}
RESAMPY = {
    "name": "resampy",
    "version": "0.2.2",
    "url": "https://files.pythonhosted.org/packages/79/75/e22272b9c2185fc8f3af6ce37229708b45e8b855fd4bc38b4d6b040fff65/resampy-0.2.2.tar.gz",
    "sha256": "62af020d8a6674d8117f62320ce9470437bb1d738a5d06cd55591b69b463929e",
}


def download_and_verify(spec: dict[str, str], destination: Path) -> Path:
    archive = destination / f"{spec['name']}-{spec['version']}.tar.gz"
    request = urllib.request.Request(
        spec["url"], headers={"User-Agent": "music-recommender-openl3-compat"}
    )
    with urllib.request.urlopen(request, timeout=120) as response, archive.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != spec["sha256"]:
        raise RuntimeError(f"{spec['name']} archive checksum mismatch")
    return archive


def extract_archive(archive: Path, destination: Path, directory: str) -> Path:
    with tarfile.open(archive, "r:gz") as bundle:
        if hasattr(tarfile, "data_filter"):
            bundle.extractall(destination, filter="data")
        else:
            bundle.extractall(destination)
    return destination / directory


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if text.count(old) != 1:
        raise RuntimeError(f"could not apply OpenL3 compatibility patch: {label}")
    return text.replace(old, new)


def patch_openl3(source: Path) -> None:
    setup = source / "setup.py"
    text = setup.read_text()
    text = replace_once(text, "import imp\n", "", "remove imp import")
    text = replace_once(
        text,
        "version = imp.load_source('openl3.version', os.path.join('openl3', 'version.py'))",
        "version_namespace = {}\n"
        "with open(os.path.join('openl3', 'version.py'), encoding='utf8') as version_file:\n"
        "    exec(version_file.read(), version_namespace)\n"
        "version = version_namespace['version']\n",
        "replace OpenL3 version loader",
    )
    text = replace_once(text, "version=version.version,", "version=version,", "fix OpenL3 version value")
    setup.write_text(text)


def patch_resampy(source: Path) -> None:
    setup = source / "setup.py"
    text = setup.read_text()
    text = replace_once(text, "import imp\n", "", "remove resampy imp import")
    text = replace_once(
        text,
        "VERSION = imp.load_source('resampy.version', 'resampy/version.py')",
        "VERSION = {}\n"
        "with open('resampy/version.py', encoding='utf8') as version_file:\n"
        "    exec(version_file.read(), VERSION)\n",
        "replace resampy version loader",
    )
    text = replace_once(text, "version=VERSION.version,", "version=VERSION['version'],", "fix resampy version value")
    setup.write_text(text)

    filters = source / "resampy" / "filters.py"
    filter_text = filters.read_text()
    filter_text = replace_once(filter_text, "import pkg_resources\n", "", "remove resampy pkg_resources import")
    filter_text = replace_once(
        filter_text,
        "data = np.load(pkg_resources.resource_filename(__name__, fname))",
        "data = np.load(os.path.join(os.path.dirname(__file__), fname))",
        "replace resampy resource lookup",
    )
    filters.write_text(filter_text)


def run_pip(*args: str) -> None:
    subprocess.run([sys.executable, "-m", "pip", *args], check=True)


def main() -> int:
    if sys.version_info < (3, 12):
        raise RuntimeError("This compatibility installer is for Python 3.12 or newer")
    try:
        import setuptools  # noqa: F401
        import wheel  # noqa: F401
    except ImportError:
        run_pip("install", "--no-cache-dir", "setuptools", "wheel")
    root = Path(__file__).resolve().parent
    with tempfile.TemporaryDirectory(prefix="music-recommender-openl3-") as temporary:
        work = Path(temporary)
        openl3_source = extract_archive(
            download_and_verify(OPENL3, work), work, f"openl3-{OPENL3['version']}"
        )
        resampy_source = extract_archive(
            download_and_verify(RESAMPY, work), work, f"resampy-{RESAMPY['version']}"
        )
        patch_openl3(openl3_source)
        patch_resampy(resampy_source)

        # Install the patched legacy packages before resolving the remaining
        # pinned dependencies, so pip never tries to build their original
        # setup.py files.
        run_pip("install", "--no-cache-dir", "--no-deps", "--no-build-isolation", str(resampy_source))
        run_pip("install", "--no-cache-dir", "--no-build-isolation", str(openl3_source))
        filtered_requirements = work / "requirements-no-legacy-sdists.txt"
        filtered_requirements.write_text(
            "".join(
                line
                for line in (root / "requirements.txt").read_text().splitlines(keepends=True)
                if not line.startswith(("openl3==", "resampy=="))
            )
        )
        run_pip("install", "--no-cache-dir", "-r", str(filtered_requirements))

    print("Patched OpenL3 0.4.2 dependencies installed successfully")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
