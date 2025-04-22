import json
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

from clvm_types.program import Program

calpoker_clsp_dir = Path("../clsp/onchain/calpoker/")

# List of validator program names, sans "clsp" extension
prog_names = ["a", "b", "c", "d", "e"]


def load_clvm_hex(path: Path) -> Program:
    with open(path, "r") as hexfile:
        return Program.fromhex(hexfile.read())


@dataclass(frozen=True)
class ValidatorInfo:
    program: Program
    name: str

# @dataclass
# class ValidatorTestCase:
#     test: TestCase

@dataclass
class TestCaseAlternative:
    alternatives: List[TestCase|TestCaseSequence|TestCaseAlternative]

@dataclass
class TestCaseSequence:
    sequence: List[TestCase|TestCaseSequence|TestCaseAlternative]

def dbg_assert_eq(expected, actual, msg=""):
    if expected != actual:
        err_msg = f"\n{msg}:\nexpected={expected}\nactual={actual}\n"
        # print(err_msg)
        raise AssertionError(err_msg)

def read_test_case(file: Path):
    with open(file, "r", encoding="utf8") as test_file:
        return json.loads(test_file.read())


def bitfield_to_byte(x):
    v = 0
    for bit in x:
        v |= 1 << bit
        # print(bit, v)
    return bytes([v])