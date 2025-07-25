"""
This is an implementation of `sha256_treehash`, used to calculate
puzzle hashes in clvm.

This implementation goes to great pains to be non-recursive so we don't
have to worry about blowing out the python stack.
"""

from __future__ import annotations

from typing import Callable, List, Optional, Set

from clvm import CLVMObject

from chia_gaming.util.sized_bytes import bytes32
from chia_gaming.util.hash import std_hash

Op = Callable[[List["CLVMObject"], List["Op"], Set[bytes32]], None] # type: ignore


def sha256_treehash(sexp: CLVMObject, precalculated: Optional[Set[bytes32]] = None) -> bytes32:
    """
    Hash values in `precalculated` are presumed to have been hashed already.
    """

    if precalculated is None:
        precalculated = set()

    def handle_sexp(sexp_stack: List[CLVMObject], op_stack: List[Op], precalculated: Set[bytes32]) -> None:
        sexp = sexp_stack.pop()
        if sexp.pair:
            p0, p1 = sexp.pair
            sexp_stack.append(p0)
            sexp_stack.append(p1)
            op_stack.append(handle_pair)
            op_stack.append(handle_sexp)
            op_stack.append(roll)
            op_stack.append(handle_sexp)
        else:
            if sexp.atom in precalculated:
                r = sexp.atom
            else:
                r = std_hash(b"\1" + sexp.atom)
            sexp_stack.append(r)

    def handle_pair(sexp_stack: List[CLVMObject], op_stack: List[Op], precalculated: Set[bytes32]) -> None:
        p0 = sexp_stack.pop()
        p1 = sexp_stack.pop()
        sexp_stack.append(std_hash(b"\2" + p0 + p1))

    def roll(sexp_stack: List[CLVMObject], op_stack: List[Op], precalculated: Set[bytes32]) -> None:
        p0 = sexp_stack.pop()
        p1 = sexp_stack.pop()
        sexp_stack.append(p0)
        sexp_stack.append(p1)

    sexp_stack = [sexp]
    op_stack: List[Op] = [handle_sexp]
    while len(op_stack) > 0:
        op = op_stack.pop()
        op(sexp_stack, op_stack, precalculated)
    return bytes32(sexp_stack[0])
