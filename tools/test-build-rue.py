"""Check the build-time boundary for both module and program-hash dependencies."""
import runpy
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


if __name__ == "__main__":
    unittest.main()
