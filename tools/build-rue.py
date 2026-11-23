#!/usr/bin/env python3
"""Build Rue programs in dependency order, or run the native Rue tests."""

import argparse
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "rue"
LAYERS = {"onchain": 0, "offchain": 1, "tests": 2}


def discover():
    registry = json.loads((ROOT / "games/registry.json").read_text())
    roots = [SOURCE] + [
        ROOT / "games" / game / "rue" for game in registry["production"] + registry["test"]
    ]
    sources = {}
    for root in roots:
        for layer in LAYERS:
            for path in sorted((root / layer).glob("*.rue")):
                if path.stem in sources:
                    raise ValueError(f"Duplicate Rue module: {path} and {sources[path.stem]}")
                sources[path.stem] = path
    return sources


def destination(entry):
    name = entry.stem
    if name == "referee":
        return ROOT / "clsp/referee/onchain/referee"
    if name == "unroll_puzzle":
        return ROOT / "clsp/unroll/unroll_puzzle_state_channel_unrolling"
    package = entry.parents[2]
    if package.parent == ROOT / "games" and name.startswith(package.name + "_"):
        puzzle = name[len(package.name) + 1:]
        directory = package / "clsp"
        if puzzle == "factory" and entry.parent.name == "offchain":
            return directory / f"factory_{package.name}_factory"
        if puzzle in ("factory", "factory_probe"):
            return directory / puzzle
        if entry.parent.name == "onchain":
            return directory / "onchain" / puzzle
    return ROOT / "clsp/test" / name


def dependency(importer, name, sources):
    path = sources[name]
    if LAYERS[path.parent.name] > LAYERS[importer.parent.name]:
        raise ValueError(f"{importer} cannot depend on {path}")
    return path


def collect(importer, sources, modules, imports):
    for module, members in re.findall(r"^import (\w+)::([^;]+);", importer.read_text(), re.M):
        if module == "artifacts":
            for symbol in members.strip().strip("{}").split(","):
                if symbol := symbol.strip():
                    name, kind = symbol.rsplit("_", 1)
                    if kind not in ("hash", "program"):
                        raise ValueError(f"Unknown artifact {symbol} in {importer}")
                    imports[symbol] = dependency(importer, name, sources)
        elif module != "std":
            path = dependency(importer, module, sources)
            if path not in modules:
                modules.add(path)
                collect(path, sources, modules, imports)


class Build:
    def __init__(self, directory, sources, cli):
        self.directory = directory
        self.sources = sources
        self.cli = cli
        self.built = {}
        self.visiting = set()

    def project(self, entry, *, testing=False):
        project = self.directory / (entry.stem + "-tests" if testing else entry.stem)
        puzzles = project / "puzzles"
        puzzles.mkdir(parents=True)
        shutil.copyfile(SOURCE / "compiler.toml", project / "Rue.toml")
        modules, imports = {entry}, {}
        collect(entry, self.sources, modules, imports)
        for path in modules:
            shutil.copyfile(path, puzzles / path.name)
        declarations = []
        for symbol, validator in sorted(imports.items()):
            program, tree_hash = self.compile(validator)
            if symbol.endswith("_hash"):
                declarations.append(f"export const {symbol}: Bytes32 = 0x{tree_hash};")
            else:
                (puzzles / f"{symbol}.hex").write_text(program)
                declarations.append(
                    f'export extern fn {symbol}(...args: Any) -> Any from "./{symbol}.hex";'
                )
        if declarations:
            (puzzles / "artifacts.rue").write_text("\n".join(declarations))
        return project

    def compile(self, entry):
        if entry in self.built:
            return self.built[entry]
        if entry in self.visiting:
            raise ValueError(f"Cyclic compiled-program dependency at {entry}")
        self.visiting.add(entry)
        project = self.project(entry)
        print(f"Compiling {entry.relative_to(ROOT)}", flush=True)
        result = subprocess.run(
            [self.cli, "build", f"puzzles/{entry.name}", "--hex", "--hash",
             "--debug-metadata=program.debug.clvm.bin"],
            cwd=project, check=True, text=True, stdout=subprocess.PIPE,
        )
        program, tree_hash = result.stdout.split()
        self.built[entry] = program, tree_hash
        self.visiting.remove(entry)
        return program, tree_hash

    def publish(self):
        for entry, (program, _) in self.built.items():
            output = destination(entry)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.with_suffix(".hex").write_text(program + "\n")
            output.with_suffix(".clvm.bin").write_bytes(bytes.fromhex(program))
            shutil.copyfile(
                self.directory / entry.stem / "program.debug.clvm.bin",
                output.with_suffix(".debug.clvm.bin"),
            )

    def test(self, entry):
        project = self.project(entry, testing=True)
        subprocess.run([self.cli, "test", f"puzzles/{entry.name}"], cwd=project, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--test", action="store_true")
    args = parser.parse_args()
    cli = shutil.which("rue") or str(ROOT / "target/rue-cli/bin/rue")
    sources = discover()
    with tempfile.TemporaryDirectory(prefix="gaming-rue-") as directory:
        build = Build(Path(directory), sources, cli)
        for entry in sources.values():
            source = entry.read_text()
            if args.test:
                if re.search(r"^test fn ", source, re.M):
                    build.test(entry)
            elif re.search(r"^fn main\(", source, re.M):
                build.compile(entry)
        if not args.test:
            build.publish()


if __name__ == "__main__":
    main()
