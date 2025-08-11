from pathlib import Path

from chia_gaming_tests.clvm_types.program import Program


def load_clvm_hex(path: Path) -> Program:
    with open(path, "r") as hexfile:
        return Program.fromhex(hexfile.read())
