import json
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union, TypeVar, Generic

from chia_gaming.clvm_types.program import Program

calpoker_clsp_dir = Path("../../clsp/games/calpoker-v1")
calpoker_onchain_clsp_dir = Path("../../clsp/games/calpoker-v1/onchain")

# List of validator program names, sans "clsp" extension
validator_program_filenames = ["a", "b", "c", "d", "e"]


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


TestCaseType = TypeVar("TestCaseType")

@dataclass
class TestCaseAlternative(Generic[TestCaseType]):
    alternatives: List["TestCaseSequence[TestCaseType]|TestCaseAlternative[TestCaseType]"]


@dataclass
class TestCaseSequence(Generic[TestCaseType]):
    sequence: List["TestCaseSequence[TestCaseType]|TestCaseAlternative[TestCaseType]"]


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
