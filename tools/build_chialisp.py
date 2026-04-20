#!/usr/bin/env python3
"""Build chialisp hex artifacts via cargo build.rs when sources change."""

from __future__ import annotations

import hashlib
import shutil
import subprocess
import sys
import time
from pathlib import Path

CACHE_NAME = ".build-chialisp.cache"
_READ_CHUNK = 1024 * 1024


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def file_sha256_hex(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(_READ_CHUNK)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def current_fingerprint_lines(root: Path) -> list[str]:
    """One line per source file: ``relative_path sha256`` (sorted)."""
    clsp = root / "clsp"
    lines: list[str] = []
    if not clsp.is_dir():
        return lines
    for pattern in ("*.clsp", "*.clinc"):
        for path in clsp.rglob(pattern):
            if path.is_file():
                rel = path.relative_to(root).as_posix()
                lines.append(f"{rel} {file_sha256_hex(path)}")
    lines.sort()
    return lines


def cache_is_current(root: Path, cache_path: Path) -> bool:
    if not cache_path.is_file():
        return False
    cached = sorted(cache_path.read_text(encoding="utf-8").splitlines())
    current = current_fingerprint_lines(root)
    return cached == current


def remove_hex_files(clsp: Path) -> None:
    if not clsp.is_dir():
        return
    for path in clsp.rglob("*.hex"):
        if path.is_file():
            path.unlink()


def main() -> int:
    root = repo_root()
    cache_path = root / CACHE_NAME
    clsp = root / "clsp"

    needs_build = not cache_is_current(root, cache_path)

    print("=== Building chialisp (via cargo build.rs) ===")

    if not needs_build:
        print("Chialisp is up to date (skipping build)")
        return 0

    t0 = time.monotonic()
    remove_hex_files(clsp)

    disabled = root / "build.rs.disabled"
    build_rs = root / "build.rs"
    if not disabled.is_file():
        print(f"error: missing {disabled}", file=sys.stderr)
        return 1

    shutil.copy2(disabled, build_rs)
    try:
        subprocess.run(
            ["cargo", "build", "--features", "sim-server"],
            cwd=root,
            check=True,
        )
    except subprocess.CalledProcessError:
        return 1
    finally:
        build_rs.unlink(missing_ok=True)

    elapsed = int(time.monotonic() - t0)
    print(f"Build took: {elapsed} seconds")
    lines = current_fingerprint_lines(root)
    payload = "\n".join(lines) + ("\n" if lines else "")
    cache_path.write_text(payload, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
