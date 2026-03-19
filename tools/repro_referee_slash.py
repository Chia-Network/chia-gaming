#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "python"))

from chia_gaming.clvm_types.program import Program  # noqa: E402


def load_hex(path: Path) -> Program:
    with path.open("r", encoding="utf8") as f:
        return Program.fromhex(f.read().strip())


def h256(*parts: bytes) -> bytes:
    m = hashlib.sha256()
    for p in parts:
        m.update(p)
    return m.digest()


def pp(label: str, value: Any) -> None:
    print(f"{label}: {value}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Directly repro referee slash execution without sim test harness."
    )
    parser.add_argument(
        "--move-len",
        type=int,
        default=31,
        help="Length of MOVE bytes passed to validator/referee (default: 31).",
    )
    parser.add_argument(
        "--move-byte",
        type=lambda s: int(s, 0),
        default=0xAA,
        help="Byte value used to fill MOVE (default: 0xAA).",
    )
    parser.add_argument(
        "--max-move-size",
        type=int,
        default=16,
        help="Committed MAX_MOVE_SIZE in referee args (default: 16).",
    )
    parser.add_argument(
        "--infohash-b-byte",
        type=lambda s: int(s, 0),
        default=0x10,
        help="Fill byte for committed INFOHASH_B atom (default: 0x10).",
    )
    parser.add_argument(
        "--aligned-infohash-b",
        action="store_true",
        help="Use aligned INFOHASH_B = sha256(b_validator_hash, shatree(MOVE)).",
    )
    args = parser.parse_args()

    referee_hex = REPO_ROOT / "clsp/referee/onchain/referee.hex"
    a_hex = REPO_ROOT / "clsp/games/calpoker/onchain/a.hex"

    referee = load_hex(referee_hex)
    a_validator = load_hex(a_hex)

    referee_hash = bytes(referee.get_tree_hash())
    a_hash = bytes(a_validator.get_tree_hash())

    move_bytes = bytes([args.move_byte & 0xFF]) * args.move_len

    previous_state = Program.to(0)
    previous_state_hash = bytes(previous_state.get_tree_hash())
    infohash_a = h256(a_hash, previous_state_hash)

    move_state_hash = bytes(Program.to(move_bytes).get_tree_hash())
    aligned_infohash_b = h256(
        bytes(load_hex(REPO_ROOT / "clsp/games/calpoker/onchain/b.hex").get_tree_hash()),
        move_state_hash,
    )
    if args.aligned_infohash_b:
        committed_infohash_b = aligned_infohash_b
    else:
        committed_infohash_b = bytes([args.infohash_b_byte & 0xFF]) * 32

    # Curried referee args:
    curried_args = [
        bytes([0x11]) * 48,   # MOVER_PUBKEY
        bytes([0x22]) * 48,   # WAITER_PUBKEY
        10,                   # TIMEOUT
        200,                  # AMOUNT
        referee_hash,         # MOD_HASH
        1,                    # NONCE
        move_bytes,           # MOVE
        args.max_move_size,   # MAX_MOVE_SIZE
        committed_infohash_b, # INFOHASH_B
        0,                    # MOVER_SHARE
        infohash_a,           # INFOHASH_A
    ]

    # Slash solution args:
    slash_args = [
        previous_state,        # previous_state
        a_validator,           # previous_validation_program
        0,                     # evidence
        bytes([0x33]) * 32,    # mover_payout_ph
    ]

    # NOTE: this is a dotted pair: (curried_args . slash_args)
    all_args = (curried_args, slash_args)

    # Referee calls validator as:
    # (a previous_validation_program (c previous_validation_program_hash all_args))
    validator_args = (a_hash, all_args)
    curried_args_hex = bytes(Program.to(curried_args)).hex()
    slash_args_hex = bytes(Program.to(slash_args)).hex()
    all_args_hex = bytes(Program.to(all_args)).hex()
    validator_args_hex = bytes(Program.to(validator_args)).hex()

    pp("referee.hex", referee_hex)
    pp("a.hex", a_hex)
    pp("MOVE len", len(move_bytes))
    pp("referee_hash", referee_hash.hex())
    pp("a_hash", a_hash.hex())
    pp("previous_state_hash", previous_state_hash.hex())
    pp("INFOHASH_A", infohash_a.hex())
    pp("aligned_INFOHASH_B", aligned_infohash_b.hex())
    pp("committed_INFOHASH_B", committed_infohash_b.hex())
    pp("CURRIED_ARGS_HEX", curried_args_hex)
    pp("SLASH_ARGS_HEX", slash_args_hex)
    pp("ALL_ARGS_HEX", all_args_hex)
    pp("VALIDATOR_CALL_ARGS_HEX", validator_args_hex)
    print()

    print("=== Running validator directly ===")
    try:
        validator_result = a_validator.run(validator_args)
        pp("validator_result.as_python()", validator_result.as_python())
    except Exception as e:
        pp("validator_error", repr(e))

    print()
    print("=== Running referee directly ===")
    try:
        referee_result = referee.run(all_args)
        pp("referee_result.as_python()", referee_result.as_python())
    except Exception as e:
        pp("referee_error", repr(e))
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
