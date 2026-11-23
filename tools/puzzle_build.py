"""Check the inputs and published outputs of the puzzle build before invoking Cargo."""
import hashlib
import json
import os
from contextlib import contextmanager
from pathlib import Path
import shutil
import subprocess
import time
import uuid


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def snapshot(paths):
    return {str(path): digest(path) for path in paths}


def puzzle_dirs():
    return [Path("clsp"), *Path("games").glob("*/clsp")]


def generated():
    return {path for root in puzzle_dirs() for path in root.rglob("*")
            if path.name.endswith((".hex", ".clvm.bin")) and path.name != "factory_args.clvm.bin"}


def inputs(compiler):
    paths = list(map(Path, ("build.rs", "Cargo.toml", "Cargo.lock", "src/factory_abi.rs",
                           "src/game_package_key.rs", "tools/build-chialisp.sh",
                           "tools/puzzle_build.py", "games/registry.json")))
    paths.extend(Path("games").glob("*/clsp/factory_args.clvm.bin"))
    if compiler == "rue":
        paths.extend(map(Path, ("rue/compiler.toml", "tools/build-rue.py", "tools/rue_metadata.rs")))
        for root in [Path("rue"), *Path("games").glob("*/rue")]:
            paths.extend(root.rglob("*.rue"))
        files = snapshot(paths)
        files["rue executable"] = digest(Path(shutil.which("rue")))
        return files
    paths.append(Path("chialisp.toml"))
    for root in puzzle_dirs():
        paths.extend(path for path in root.rglob("*") if path.suffix in (".clsp", ".clinc"))
    return snapshot(paths)


def outputs():
    paths = generated()
    manifest = Path("games/package_manifest.json")
    if manifest.exists():
        paths.add(manifest)
    return snapshot(paths)


def check_outputs(files):
    hex_files = [Path(name) for name in files if name.endswith(".hex")]
    if not hex_files:
        raise RuntimeError("puzzle build produced no .hex files")
    required = {Path("games/package_manifest.json")}
    for path in hex_files:
        required.update(path.with_suffix(ext) for ext in (".clvm.bin", ".debug.clvm.bin"))
    for key in json.loads(Path("games/registry.json").read_text())["production"]:
        root = Path("games") / key / "clsp"
        required.update(root / name for name in
                        ("factory_prepared.clvm.bin", "factory_prepared.debug.clvm.bin"))
    missing = sorted(str(path) for path in required if str(path) not in files)
    if missing:
        raise RuntimeError("missing generated files: " + ", ".join(missing))


def build():
    compiler = os.environ["GAMING_PUZZLE_COMPILER"]
    state = Path(".build-chialisp.state")
    print(f"=== Building puzzles with {compiler} ===", flush=True)
    before = inputs(compiler)

    def record(files):
        return json.dumps([compiler, before, files], sort_keys=True).encode()

    if os.environ.get("GITHUB_ACTIONS") != "true" and state.is_file():
        if state.read_bytes() == record(outputs()):
            print("Puzzle artifacts are up to date")
            return
    while True:
        if compiler == "chialisp":
            for path in generated() | {Path("games/package_manifest.json")}:
                path.unlink(missing_ok=True)
        subprocess.run(["cargo", "build", "--locked", "--features", "sim-server"], check=True,
                       env={**os.environ, "CHIALISP_COMPILE": uuid.uuid4().hex})
        files = outputs()
        check_outputs(files)
        after = inputs(compiler)
        if before == after:
            pending = state.with_suffix(".state.tmp")
            pending.write_bytes(record(files))
            pending.replace(state)
            return
        print("Puzzle inputs changed during the build. Rebuilding.", flush=True)
        before = after


@contextmanager
def build_lock():
    # Serialize the freshness check, publication, and stamp across build invocations.
    lock = Path("target/puzzle-build.lock")
    lock.parent.mkdir(exist_ok=True)
    with lock.open("a+b") as handle:
        if os.name == "nt":
            import msvcrt
            handle.seek(0)
            while True:
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except PermissionError:
                    time.sleep(0.1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX)
        yield


if __name__ == "__main__":
    with build_lock():
        build()
