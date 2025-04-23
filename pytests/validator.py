from __future__ import annotations

import subprocess
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple, Union

from clvm_types.program import Program
from clvm_types.sized_bytes import bytes32
from load_clvm_hex import load_clvm_hex
from util import ValidatorInfo, calpoker_onchain_clsp_dir, validator_program_filenames, dbg_assert_eq
from validator_hashes import program_hashes_hex
from validator_output import Move, MoveCode, Slash


def create_validator_program_library():
    """
    Gather CalPoker validator progarms and their hashes, allowing us to check the hash
    that is output as the next validation program hash (called "bhash" in {a,b,c,d,e}.clsp)
    """
    # TODO: Use the clsp feature that exports module hash
    lib = {}
    for hex_key, prog_name in zip(program_hashes_hex, validator_program_filenames):
        lib[bytes.fromhex(hex_key)] = ValidatorInfo(
            load_clvm_hex(calpoker_onchain_clsp_dir / f"{prog_name}.hex"), prog_name
        )
    # TODO: sanity check step_a_hash = step_a.get_tree_hash()
    return lib


game_arg_names = "MOVER_PUZZLE_HASH WAITER_PUZZLE_HASH TIMEOUT AMOUNT MOD_HASH NONCE MOVE MAX_MOVE_SIZE VALIDATION_INFO_HASH MOVER_SHARE PREVIOUS_VALIDATION_INFO_HASH".lower().split()
validator_arg_names = [
    "validator_hash",
    "arglist",
    "previous_state",
    "previous_validation_program",
    "mover_puzzle",
    "solution",
    "evidence",
]

"""
(mod_hash
    (MOVER_PUZZLE_HASH WAITER_PUZZLE_HASH TIMEOUT AMOUNT MOD_HASH NONCE
        MOVE MAX_MOVE_SIZE VALIDATION_INFO_HASH MOVER_SHARE PREVIOUS_VALIDATION_INFO_HASH)
        previous_state previous_validation_program mover_puzzle solution evidence)

"""


def print_validator_input_args(args, arg_names):
    print("PYTHON INPUT ARGS: ")
    for name, arg in zip(arg_names, args):
        print(f"{name}: {arg}")
        if name == "waiter_puzzle_hash":
            print(
                f"WAITER PUZZLE HASH (waiter_puzzle_hash) OVERLAPS WITH on_chain. on_chain={not not arg}"
            )
        if name == "bob_card_selections":
            print(f"{Program.to(arg).as_int()}")

    print("CLVM INPUT ARGS: ")
    print(Program.to(args))
    print(Program.to(args).as_python())


def print_validator_output(args):
    output_names = ["move_type", "next_program_hash"]
    print("VALIDATOR OUTPUT:")
    for name, arg in zip(output_names, args):
        print(f"    {name}: {arg}")


@dataclass(frozen=True)
class GameEnvironment:
    validator_program_library: Dict[bytes32, ValidatorInfo]
    amount: int


def construct_validator_output(prog: Program) -> Move | Slash:
    clvm_list = prog.as_python()
    if len(clvm_list) < 2:
        raise ValueError(f"Expected MoveType and at least one data item. Got: {prog}")
    move_code = MoveCode(Program.to(clvm_list[0]).as_int())
    if move_code == MoveCode.MAKE_MOVE:
        max_move_size = Program.to(clvm_list[3]).as_int()
        if int(max_move_size) < 0:
            raise ("Negative max_move_size")
        new_hash = None
        # Handle special case in output of e.clsp
        if len(clvm_list[1]) > 0:
            new_hash = bytes32(clvm_list[1])
        return Move(
            move_code, new_hash, clvm_list[2], max_move_size, Program.to(clvm_list[4:])
        )
    else:
        print(f"As Python: {clvm_list}")
        assert move_code == MoveCode.SLASH
        return Slash(move_code, Program.to(clvm_list[1]), Program.to(clvm_list[2:]))


def run_one_step(
        game_env, # amount
        script, # (move, mover_share, evidence, expected_move_type, on_chain)
        last_move, # (next_validator_hash, next_max_move_size, state)
        validator_program,
        expected_move_type): # -> MoveOrSlash

    # TODO: See if compose_validator_args will save code later XOR delete
    # WAITER_PUZZLE_HASH doubles as an "on_chain" indicator

    move_to_make = script[0]
    mover_share = script[1]
    evidence = script[2]
    on_chain = script[4]
    args = [
        last_move.next_validator_hash,
        [None, on_chain, None, game_env.amount, None, None,
         move_to_make, last_move.next_max_move_size, None, mover_share, None],
        last_move.state, validator_program, None, None, evidence
    ]

    print(f'max_move_size_to_apply {last_move.next_max_move_size}')
    print(f'move is {move_to_make}')

    # assert len(move_to_make) <= last_move.next_max_move_size

    print_validator_input_args(args[1], game_arg_names)

    # Use this code to automatically run cldb on the program and args that failed
    # print("CLDB RUN")
    # program_hex = bytes(Program.to(validator_program)).hex()
    # args_hex = bytes(Program.to(args)).hex()
    # cldb_output = subprocess.check_output(['/usr/bin/env','cldb','-x','-p',program_hex,args_hex])
    # print(cldb_output.decode('utf8'))

    ret_val = validator_program.run(args)

    print(f"RAW VALIDATOR OUTPUT {ret_val}")

    validator_output = construct_validator_output(ret_val)

    dbg_assert_eq(expected_move_type, validator_output.move_code)

    if validator_output.move_code == MoveCode.SLASH or validator_output.next_validator_hash is None:
        # XXX Maybe do additional checks
        return validator_output

    print(f"validator_output.move_code={validator_output.move_code} expected_move_type={expected_move_type}")
    print(f"ADAM {validator_output}")
    return validator_output

def run_validator(
    game_env,  # amount
    script,  # (move, mover_share, evidence, expected_move_type, on_chain)
    last_move,  # (next_validator_hash, next_max_move_size, state)
    validator_program,
    expected_move_type,
):  # -> MoveOrSlash

    # TODO: See if compose_validator_args will save code later XOR delete
    # WAITER_PUZZLE_HASH doubles as an "on_chain" indicator

    move_to_make = script[0]
    mover_share = script[1]
    evidence = script[2]
    on_chain = script[4]
    args = [
        last_move.next_validator_hash,
        [
            None,
            on_chain,
            None,
            game_env.amount,
            None,
            None,
            move_to_make,
            last_move.next_max_move_size,
            None,
            mover_share,
            None,
        ],
        last_move.state,
        validator_program,
        None,
        None,
        evidence,
    ]

    print(f"max_move_size_to_apply {last_move.next_max_move_size}")
    print(f"move is {move_to_make}")

    # assert len(move_to_make) <= last_move.next_max_move_size

    print_validator_input_args(args[1], game_arg_names)

    # Use this code to automatically run cldb on the program and args that failed
    print("CLDB RUN")
    program_hex = bytes(Program.to(validator_program)).hex()
    args_hex = bytes(Program.to(args)).hex()
    cldb_output = subprocess.check_output(['/usr/bin/env','cldb','-x','-p',program_hex,args_hex])
    print(cldb_output.decode('utf8'))

    ret_val = validator_program.run(args)

    print(f"RAW VALIDATOR OUTPUT {ret_val}")

    validator_output = construct_validator_output(ret_val)

    if expected_move_type is not None:
        dbg_assert_eq(expected_move_type, validator_output.move_code)

    if (
        validator_output.move_code == MoveCode.SLASH
        or validator_output.next_validator_hash is None
    ):
        # XXX Maybe do additional checks
        return validator_output

    print(
        f"validator_output.move_code={validator_output.move_code} expected_move_type={expected_move_type}"
    )
    print(f"ADAM {validator_output}")
    return validator_output
