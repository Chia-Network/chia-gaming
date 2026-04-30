"""Tests for build_chialisp.py.

Fast-mode tests (default) use tmp_path to verify cache-based decision logic.
Full-build tests (--full-build) run cargo build against the real repo.

The full-build tests verify that build.rs.disabled (the cargo build script)
actually produces .hex output files in the clsp/ tree.  The build script
compiles each entry in chialisp.toml via the chialisp compiler's compile_file,
which returns CompilerOutput::Module (for files with ``(export ...)``
directives) or CompilerOutput::Program.  For modules, the compiler writes hex
files as a side-effect; the build script also includes an explicit fallback
that serializes and writes any missing hex files.

Run full-build tests via: tools/test-build-chialisp.sh
(this wrapper ensures build.rs is in place for the duration of the test suite).
"""

from __future__ import annotations

import hashlib
import os
import shutil
import textwrap
from pathlib import Path
from unittest.mock import MagicMock

import pytest

import build_chialisp as bc

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

DUMMY_CLSP = textwrap.dedent("""\
    (mod () (list 1))
""")

DUMMY_CLINC = textwrap.dedent("""\
    (
        (defmacro add1 (X) (+ X 1))
    )
""")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_sources(root: Path) -> None:
    """Create a minimal clsp/ tree with a couple of source files."""
    clsp = root / "clsp"
    clsp.mkdir(parents=True, exist_ok=True)
    (clsp / "foo.clsp").write_text(DUMMY_CLSP)
    (clsp / "bar.clinc").write_text(DUMMY_CLINC)
    sub = clsp / "sub"
    sub.mkdir(exist_ok=True)
    (sub / "baz.clsp").write_text(DUMMY_CLSP + "; baz\n")


def _write_matching_cache(root: Path) -> Path:
    """Write a cache file that matches the current sources. Returns cache path."""
    cache_path = root / bc.CACHE_NAME
    lines = bc.current_fingerprint_lines(root)
    payload = "\n".join(lines) + ("\n" if lines else "")
    cache_path.write_text(payload, encoding="utf-8")
    return cache_path


def _create_hex_files(clsp: Path, names: list[str]) -> list[Path]:
    """Create dummy .hex files under clsp/."""
    paths = []
    for name in names:
        p = clsp / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("ff01ff01808080")
        paths.append(p)
    return paths


# ===========================================================================
# Fast-mode tests (decision logic, no cargo)
# ===========================================================================


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

class TestInternalHelpers:
    def test_hex_file_set(self, tmp_path: Path):
        hex_file_set_start = _hex_file_set(tmp_path)
        new_hex_file = tmp_path / "xyzzy.hex"
        assert not os.path.exists(new_hex_file)
        Path.touch(new_hex_file)
        assert os.path.exists(new_hex_file)
        hex_file_set_now = _hex_file_set(tmp_path)
        assert len(hex_file_set_start) + 1 == len(hex_file_set_now)

    def test_empty_when_no_clsp_dir(self, tmp_path: Path) -> None:
        assert bc.current_fingerprint_lines(tmp_path) == []

    def test_finds_clsp_and_clinc(self, tmp_path: Path) -> None:
        _write_sources(tmp_path)
        lines = bc.current_fingerprint_lines(tmp_path)
        assert len(lines) == 3
        paths_found = [line.split()[0] for line in lines]
        assert "clsp/bar.clinc" in paths_found
        assert "clsp/foo.clsp" in paths_found
        assert "clsp/sub/baz.clsp" in paths_found

    def test_lines_are_sorted(self, tmp_path: Path) -> None:
        _write_sources(tmp_path)
        lines = bc.current_fingerprint_lines(tmp_path)
        assert lines == sorted(lines)

    def test_hash_changes_with_content(self, tmp_path: Path) -> None:
        _write_sources(tmp_path)
        lines_before = bc.current_fingerprint_lines(tmp_path)
        (tmp_path / "clsp" / "foo.clsp").write_text(DUMMY_CLSP + "; modified\n")
        lines_after = bc.current_fingerprint_lines(tmp_path)
        assert lines_before != lines_after


class TestCacheIsCurrent:
    def test_no_cache_triggers_build(self, tmp_path: Path) -> None:
        """Scenario 1: no cache file -> needs build."""
        _write_sources(tmp_path)
        cache_path = tmp_path / bc.CACHE_NAME
        assert not bc.cache_is_current(tmp_path, cache_path)

    def test_partial_hex_no_cache_triggers_build(self, tmp_path: Path) -> None:
        """Scenario 2: hex files exist from a partial build, but no cache."""
        _write_sources(tmp_path)
        clsp = tmp_path / "clsp"
        _create_hex_files(clsp, ["foo.hex", "sub/baz.hex"])
        cache_path = tmp_path / bc.CACHE_NAME
        assert not bc.cache_is_current(tmp_path, cache_path)

    def test_source_hash_changed_triggers_build(self, tmp_path: Path) -> None:
        """Scenario 3: source file modified after cache was written."""
        _write_sources(tmp_path)
        cache_path = _write_matching_cache(tmp_path)
        assert bc.cache_is_current(tmp_path, cache_path)
        (tmp_path / "clsp" / "foo.clsp").write_text(DUMMY_CLSP + "; changed\n")
        assert not bc.cache_is_current(tmp_path, cache_path)

    def test_sources_unchanged_skips_build(self, tmp_path: Path) -> None:
        """Scenario 4: sources identical to last run -> no build."""
        _write_sources(tmp_path)
        cache_path = _write_matching_cache(tmp_path)
        assert bc.cache_is_current(tmp_path, cache_path)

    def test_new_source_file_triggers_build(self, tmp_path: Path) -> None:
        """Scenario 6: a new .clsp file is added after cache was written."""
        _write_sources(tmp_path)
        cache_path = _write_matching_cache(tmp_path)
        assert bc.cache_is_current(tmp_path, cache_path)
        (tmp_path / "clsp" / "new_game.clsp").write_text("(mod () (list 42))\n")
        assert not bc.cache_is_current(tmp_path, cache_path)


class TestRemoveHexFiles:
    def test_removes_all_hex(self, tmp_path: Path) -> None:
        clsp = tmp_path / "clsp"
        _write_sources(tmp_path)
        _create_hex_files(clsp, ["foo.hex", "sub/deep.hex"])
        assert list(clsp.rglob("*.hex"))
        bc.remove_hex_files(clsp)
        assert not list(clsp.rglob("*.hex"))

    def test_no_error_when_no_hex(self, tmp_path: Path) -> None:
        clsp = tmp_path / "clsp"
        clsp.mkdir()
        bc.remove_hex_files(clsp)

    def test_no_error_when_no_dir(self, tmp_path: Path) -> None:
        bc.remove_hex_files(tmp_path / "nonexistent")


class TestNoChangesNoCompile:
    """Scenario 5: sources unchanged -> cargo is never invoked."""

    def test_main_skips_cargo_when_cache_matches(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _write_sources(tmp_path)

        # Also create build.rs.disabled so main() wouldn't fail for that reason
        (tmp_path / "build.rs.disabled").write_text("// stub")

        _write_matching_cache(tmp_path)

        monkeypatch.setattr(bc, "repo_root", lambda: tmp_path)

        mock_run = MagicMock()
        monkeypatch.setattr("subprocess.run", mock_run)

        ret = bc.main()
        assert ret == 0
        mock_run.assert_not_called()


# ===========================================================================
# Full-build tests (--full-build, operates on real repo)
# ===========================================================================


@pytest.fixture()
def save_restore_build_state():
    """Save and restore .build-chialisp.cache and hex files around a test."""
    root = bc.repo_root()
    cache_path = root / bc.CACHE_NAME
    clsp = root / "clsp"

    had_cache = cache_path.is_file()
    cache_backup = cache_path.read_bytes() if had_cache else None

    hex_files: dict[Path, bytes] = {}
    for p in clsp.rglob("*.hex"):
        hex_files[p] = p.read_bytes()

    yield root, cache_path, clsp

    # Restore cache
    if had_cache:
        cache_path.write_bytes(cache_backup)  # type: ignore[arg-type]
    else:
        cache_path.unlink(missing_ok=True)

    # Remove any hex files that weren't there before
    for p in clsp.rglob("*.hex"):
        if p not in hex_files:
            p.unlink(missing_ok=True)

    # Restore hex files that were there before
    for p, content in hex_files.items():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(content)


def _hex_file_set(clsp: Path) -> set[Path]:
    return {p for p in clsp.rglob("*.hex") if p.is_file()}


@pytest.mark.full_build
class TestFullBuild:
    def test_full_no_cache_builds_all(
        self, save_restore_build_state: tuple[Path, Path, Path]
    ) -> None:
        """Scenario 1 (full): no cache, no hex -> build produces hex files."""
        root, cache_path, clsp = save_restore_build_state
        cache_path.unlink(missing_ok=True)
        bc.remove_hex_files(clsp)
        assert not list(clsp.rglob("*.hex"))

        ret = bc.main()
        assert ret == 0

        hex_files = _hex_file_set(clsp)
        assert len(hex_files) > 0, "Expected hex files to be produced"
        assert cache_path.is_file(), "Cache should be written after build"

    #xxx
    def test_full_partial_hex_builds_all(
        self, save_restore_build_state: tuple[Path, Path, Path]
    ) -> None:
        """Scenario 2 (full): one hex missing, no cache -> all rebuilt."""
        root, cache_path, clsp = save_restore_build_state
        print(save_restore_build_state)

        # First ensure we have a full set of hex files by running a build
        cache_path.unlink(missing_ok=True)
        bc.remove_hex_files(clsp)
        ret = bc.main()
        assert ret == 0
        full_hex_set = _hex_file_set(clsp)
        assert len(full_hex_set) > 0

        # Now delete cache and remove one hex file
        cache_path.unlink(missing_ok=True)
        victim = next(iter(full_hex_set))
        victim.unlink()

        ret = bc.main()
        assert ret == 0

        rebuilt_hex_set = _hex_file_set(clsp)
        assert rebuilt_hex_set == full_hex_set, (
            f"Missing: {full_hex_set - rebuilt_hex_set}"
        )

    def test_full_source_changed_builds(
        self, save_restore_build_state: tuple[Path, Path, Path]
    ) -> None:
        """Scenario 3 (full): modified source -> rebuild."""
        root, cache_path, clsp = save_restore_build_state

        # Ensure up-to-date cache first
        cache_path.unlink(missing_ok=True)
        bc.remove_hex_files(clsp)
        ret = bc.main()
        assert ret == 0
        assert cache_path.is_file()

        # Pick a source file and append a harmless comment
        target = next(clsp.rglob("*.clsp"))
        original = target.read_text()
        target.write_text(original + "\n; test modification\n")
        try:
            assert not bc.cache_is_current(root, cache_path)
            ret = bc.main()
            assert ret == 0
            assert len(_hex_file_set(clsp)) > 0
        finally:
            target.write_text(original)

    def test_full_unchanged_skips(
        self, save_restore_build_state: tuple[Path, Path, Path]
    ) -> None:
        """Scenario 4+5 (full): nothing changed -> no rebuild, cargo not invoked."""
        root, cache_path, clsp = save_restore_build_state

        # Ensure up-to-date cache
        cache_path.unlink(missing_ok=True)
        bc.remove_hex_files(clsp)
        ret = bc.main()
        assert ret == 0

        hex_before = {p: p.stat().st_mtime_ns for p in _hex_file_set(clsp)}

        # Run again -- should skip
        ret = bc.main()
        assert ret == 0

        hex_after = {p: p.stat().st_mtime_ns for p in _hex_file_set(clsp)}
        assert hex_before == hex_after, "Hex files should not have been rebuilt"

    def test_full_new_source_triggers_build(
        self, save_restore_build_state: tuple[Path, Path, Path]
    ) -> None:
        """Scenario 6 (full): new .clsp file added -> rebuild."""
        root, cache_path, clsp = save_restore_build_state

        # Ensure up-to-date cache
        cache_path.unlink(missing_ok=True)
        bc.remove_hex_files(clsp)
        ret = bc.main()
        assert ret == 0
        assert bc.cache_is_current(root, cache_path)

        new_file = clsp / "test" / "_tmp_test_new_file.clsp"
        new_file.parent.mkdir(parents=True, exist_ok=True)
        new_file.write_text("(mod () (list 99))\n")
        try:
            assert not bc.cache_is_current(root, cache_path)
            ret = bc.main()
            assert ret == 0
            assert len(_hex_file_set(clsp)) > 0
        finally:
            new_file.unlink(missing_ok=True)
