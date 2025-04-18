from enum import Enum
from dataclasses import dataclass
from clvm_types.program import Program
from clvm_types.sized_bytes import bytes32
from typing import TypeVar, Union


class MoveCode(Enum):
    MAKE_MOVE = 0
    ACCEPT = 1
    SLASH = 2
    TIMEOUT = 3
    SLASHED = 4
    TIMEDOUT = 5
    # 
    CLVM_EXCEPTION = 6


@dataclass(frozen=True)
class Move:
    move_code: MoveCode
    next_validator_hash: bytes32
    state: Program
    next_max_move_size: int
    extra_data: Program

    #def __repr__():
    #    return

@dataclass(frozen=True)
class Slash:
    move_code: MoveCode
    evidence: Program
    extra_data: Program

MoveOrSlash = TypeVar("MoveOrSlash", bound=Union["Slash", "Move"])
