"""Exercise the Rue dependency boundary and incremental compiler with real projects."""
import os
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

builder = runpy.run_path(str(Path(__file__).with_name("build-rue.py")))


class Imports(unittest.TestCase):
    def test_onchain_dependencies(self):
        with tempfile.TemporaryDirectory() as tmp:
            def module(layer, name, body):
                path = Path(tmp) / layer / f"{name}.rue"
                path.parent.mkdir(exist_ok=True)
                path.write_text(body)
                return path

            validator = module("onchain", "validator", "import helper::*;")
            helper = module("onchain", "helper", "")
            handler = module("offchain", "handler", "import validator::*;")
            fixture = module("tests", "fixture", "import handler::*;")
            sources = {p.stem: p for p in (validator, helper, handler, fixture)}
            builder["collect"](fixture, sources, set(), {})
            for reference in ("import handler::*;", "import artifacts::{handler_hash};",
                              "import artifacts::{fixture_program};"):
                with self.subTest(reference=reference):
                    helper.write_text(reference)
                    with self.assertRaisesRegex(ValueError, "helper.rue cannot depend on"):
                        builder["collect"](validator, sources, set(), {})
            handler.write_text("import fixture::*;")
            with self.assertRaisesRegex(ValueError, "handler.rue cannot depend on"):
                builder["collect"](handler, sources, set(), {})


class IncrementalBuild(unittest.TestCase):
    def test_rebuilds_stale_dependencies_and_outputs(self):
        repo = Path(__file__).resolve().parents[1]
        cli = shutil.which("rue") or shutil.which("rue", path=str(repo / "target/rue-cli/bin"))
        self.assertIsNotNone(cli, "run ./cb.sh to install Rue")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for path in ("tools/build-rue.py", "tools/puzzle_build.py", "rue/compiler.toml"):
                (root / path).parent.mkdir(exist_ok=True)
                shutil.copyfile(repo / path, root / path)
            (root / "games").mkdir()
            (root / "games/registry.json").write_text('{"test": [], "production": []}')
            (root / "rue/onchain").mkdir()
            (root / "rue/offchain").mkdir()
            helper = root / "rue/onchain/helper.rue"
            helper.write_text("export const VALUE: Int = 42;")
            (root / "rue/onchain/leaf.rue").write_text(
                "import helper::VALUE;\nfn main() -> Int { VALUE }")
            (root / "rue/onchain/middle.rue").write_text(
                "import artifacts::leaf_hash;\nfn main() -> Bytes32 { leaf_hash }")
            (root / "rue/offchain/handler.rue").write_text(
                "import artifacts::{middle_program, leaf_hash};\n"
                "fn main() -> Any { [tree_hash(middle_program), leaf_hash] }")
            (root / "rue/onchain/other.rue").write_text("fn main() -> Int { 5 }")

            def build():
                result = subprocess.run([sys.executable, "tools/build-rue.py"], cwd=root,
                                        env={**os.environ, "GITHUB_ACTIONS": "",
                                             "PATH": str(Path(cli).parent) + os.pathsep + os.environ["PATH"]},
                                        capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                return {Path(line.split(" ", 1)[1]).stem for line in result.stdout.splitlines()
                        if line.startswith("Compiling ")}

            all_programs = {"leaf", "middle", "handler", "other"}
            self.assertEqual(build(), all_programs)
            helper.touch()
            self.assertEqual(build(), set())
            handler = root / "clsp/test/handler.clvm.bin"
            leaf = root / "clsp/test/leaf.clvm.bin"
            os.utime(leaf, (1, 1))
            helper.write_text("// Move the source span.\nexport const VALUE: Int = 42;")
            self.assertEqual(build(), {"leaf"})
            self.assertEqual(leaf.stat().st_mtime, 1)
            original = handler.read_bytes()
            helper.write_text("export const VALUE: Int = 43;")
            os.utime(helper, (1, 1))
            self.assertEqual(build(), {"leaf", "middle", "handler"})
            changed = handler.read_bytes()
            self.assertNotEqual(original, changed)
            # A fresh build must produce the same embedded hash and program.
            shutil.rmtree(root / "target/rue-build")
            self.assertEqual(build(), all_programs)
            self.assertEqual(handler.read_bytes(), changed)
            for ext in (".hex", ".clvm.bin", ".debug.clvm.bin"):
                with self.subTest(ext=ext):
                    artifact = (root / "clsp/test/middle").with_suffix(ext)
                    good = artifact.read_bytes()
                    artifact.write_bytes(b"stale")
                    self.assertEqual(build(), {"middle"})
                    self.assertEqual(artifact.read_bytes(), good)
                    artifact.unlink()
                    self.assertEqual(build(), {"middle"})
                    self.assertEqual(artifact.read_bytes(), good)
            (root / "rue/onchain/other.rue").unlink()
            self.assertEqual(build(), set())
            self.assertFalse(list((root / "clsp/test").glob("other.*")))


if __name__ == "__main__":
    unittest.main()
