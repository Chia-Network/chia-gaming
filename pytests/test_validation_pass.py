from __future__ import annotations

from typing import Any, Optional, Dict, List, Tuple
from pathlib import Path
from hashlib import sha256
from validator_hashes import program_hashes_hex
from clvm_tools_rs import start_clvm_program
from load_clvm import load_clvm
from validator_output import MoveCode, Move, Slash, MoveOrSlash
from clvm_types.sized_bytes import bytes32
from dataclasses import dataclass
from clvm_types.program import Program
import traceback

# TODO: check returned/next max_move size value

# Note: WAITER_PUZZLE_HASH == nil, signifying off-chain

# non-nil vars for tests in a.clsp:
# AMOUNT MOVE MAX_MOVE_SIZE MOVER_SHARE
# previous_state evidence

# previous_state is hash-checked against a value that *IS* curried-in
# e.clsp: evidence == nil (off chain)
# e.clsp: evidence == bob's selections (on-chain)

# TODO: Generate initial state & initial moves

from enum import Enum

calpoker_clsp_dir = Path("../clsp/onchain/calpoker/")

# List of validator program names, sans "clsp" extension
prog_names = ["a", "b", "c", "d", "e"]

@dataclass(frozen=True)
class ValidatorInfo:
    program: Program
    name: str


def create_validator_program_library():
    """
    Gather CalPoker validator progarms and their hashes, allowing us to check the hash
    that is output as the next validation program hash (called "bhash" in {a,b,c,d,e}.clsp)
    """
    # TODO: Use the clsp feature that exports module hash
    lib = {}
    for hex_key, prog_name in zip(program_hashes_hex, prog_names):
        lib[bytes.fromhex(hex_key)] = ValidatorInfo(load_clvm(calpoker_clsp_dir / prog_name, recompile=False), prog_name)
    # TODO: sanity check step_a_hash = step_a.get_tree_hash()
    return lib

validator_program_library = create_validator_program_library()

def construct_validator_output(prog: Program) -> Move | Slash:
    clvm_list = prog.as_python()
    if len(clvm_list) < 2:
        raise ValueError(f"Expected MoveType and at least one data item. Got: {prog}")
    move_code = MoveCode(Program.to(clvm_list[0]).as_int())
    max_move_size = Program.to(clvm_list[3]).as_int()
    if move_code == MoveCode.MAKE_MOVE:
        if int(max_move_size) < 0:
            raise("Negative max_move_size")
        return Move(move_code, bytes32(clvm_list[1]), clvm_list[2], max_move_size, Program.to(clvm_list[4:]))
    else:
        print(f"AAA {clvm_list}")
        assert move_code == MoveCode.SLASH
        return Slash(move_code, Program.to(clvm_list[1]), Program.to(clvm_list[2:]))


# validator_mod_hash
# replacements: pass in values that you want to set to non-default values
def compose_validator_args(validator_mod_hash): # , replacements):
    """
    (mod_hash
        (MOVER_PUZZLE_HASH WAITER_PUZZLE_HASH TIMEOUT AMOUNT MOD_HASH NONCE
            MOVE MAX_MOVE_SIZE VALIDATION_INFO_HASH MOVER_SHARE PREVIOUS_VALIDATION_INFO_HASH)
            previous_state previous_validation_program mover_puzzle solution evidence)
    """

    amount = 200
    max_move_size = 0
    #mover share: xch the current player will recv if a timeout happens (no way to concede directly in protocol)
    mover_share = 10
    previous_state = 0
    evidence = 0

    mover_puzzle_hash = 0
    waiter_puzzle_hash = 0
    timeout = 0
    mod_hash = "" # TODO
    nonce = 0
    previous_validation_program = 0

    validation_info_hash = 0
    mover_share = 0
    previous_validation_info_hash = 0
    mover_puzzle = 0
    solution = 0

    move = ""
    args = [previous_state, previous_validation_program, mover_puzzle, solution, evidence]
    curry_args = (mover_puzzle_hash, waiter_puzzle_hash, timeout, amount, mod_hash, nonce, move, max_move_size, validation_info_hash, mover_share, previous_validation_info_hash)
    # a_curry_args = (mover_puzzle_hash, waiter_puzzle_hash, timeout, amount, mod_hash, nonce, move, max_move_size, validation_info_hash, mover_share, previous_validation_info_hash)
    #return { "args": args, "curry_args": curry_args }
    """
    (mod_hash
        (MOVER_PUZZLE_HASH WAITER_PUZZLE_HASH TIMEOUT AMOUNT MOD_HASH NONCE
            MOVE MAX_MOVE_SIZE VALIDATION_INFO_HASH MOVER_SHARE PREVIOUS_VALIDATION_INFO_HASH)
            previous_state previous_validation_program mover_puzzle solution evidence)
    """
    return [validator_mod_hash, curry_args, previous_state, previous_validation_program, mover_puzzle, solution, evidence]


game_arg_names = "MOVER_PUZZLE_HASH WAITER_PUZZLE_HASH TIMEOUT AMOUNT MOD_HASH NONCE MOVE MAX_MOVE_SIZE VALIDATION_INFO_HASH MOVER_SHARE PREVIOUS_VALIDATION_INFO_HASH".lower().split()
validator_arg_names = [
        "validator_hash",
        "arglist",
        "previous_state", "previous_validation_program", "mover_puzzle", "solution", "evidence"]

#def test_validate_picks():
# 1. Pass in initial state and a series of moves
# 2. Call the next validation program with (move, movershare) for that turn
# 3. Save return values to be passed on
# Check that we got "Not slash" as expected, new mover puzzle hash, and the



"""
(mod_hash
    (MOVER_PUZZLE_HASH WAITER_PUZZLE_HASH TIMEOUT AMOUNT MOD_HASH NONCE
        MOVE MAX_MOVE_SIZE VALIDATION_INFO_HASH MOVER_SHARE PREVIOUS_VALIDATION_INFO_HASH)
        previous_state previous_validation_program mover_puzzle solution evidence)

"""

def print_validator_input_args(args, arg_names):
    print ("PYTHON INPUT ARGS: ")
    for name, arg in zip(arg_names, args):
        print(f"{name}: {arg}")
    print ("CLVM INPUT ARGS: ")
    print(Program.to(args))

def print_validator_output(args):
    output_names = [ "move_type", "next_program_hash" ]
    print("VALIDATOR OUTPUT:")
    for name, arg in zip(output_names, args):
        print(f"    {name}: {arg}")


#def run_one_step(validator_hash, validator, amount: int, move, max_move_size: int, mover_share, state, evidence,
#                 expected_move_type: MoveCode, on_chain: bool) -> MoveOrSlash:

def run_one_step(
                game_env, # amount
                script, # (move, mover_share, evidence, expected_move_type, on_chain)
                last_move, # (next_validator_hash, next_max_move_size, state)
                validator_program,
                expected_move_type):

    # TODO: See if compose_validator_args will save code later XOR delete
    # WAITER_PUZZLE_HASH doubles as an "on_chain" indicator

    move_to_make = script[0]
    mover_share = script[1]
    evidence = script[2]
    on_chain = script[4]
    args = [last_move.next_validator_hash,
                            [None, on_chain, None, game_env.amount, None, None,
                            move_to_make, last_move.next_max_move_size, None, mover_share, None],
                            last_move.state, validator_program, None, None, evidence]
    try:
        print_validator_input_args(args[1], game_arg_names)
        ret_val = validator_program.run(args)
    except Exception as e:
        print(e)
        assert expected_move_type == MoveCode.SLASH
        return None

    validator_output = construct_validator_output(ret_val)
    print(f"validator_output.move_code={validator_output.move_code} expected_move_type={expected_move_type}")
    print(f"ADAM {validator_output}")
    assert validator_output.move_code == expected_move_type
    return validator_output

@dataclass(frozen=True)
class GameEnvironment:
    validator_program_library: Dict[bytes32, ValidatorInfo]
    amount: int


# def run_game(validator_program_library, amount, validator_hash, state, max_move_size: int, remaining_script: List, n=0):
def run_game(game_environment: GameEnvironment, last_move: Move, remaining_script):
    for script in remaining_script:
        if isinstance(script, list):
            run_game(game_environment, last_move, script)
            return

        # ENV: validator_program_library, amount,
        # MOVE: validator_hash, state, max_move_size,
        # t, n+1
        (move, mover_share, evidence, expected_move_type, on_chain, *rest_of_args) = script
        print(f"""
            remaining_script: {remaining_script}
            remaining_script[0]: {remaining_script[0]}
            --
            expected_move_type={expected_move_type}
            move={move}
            max_move_size={last_move.next_max_move_size}
            mover_share={mover_share} # How much the player who is currently moving *would get* if the game is ended - comes from handler
            evidence={evidence}
            on_chain={on_chain}
            rest_of_args={rest_of_args}

    """)
        assert len(move) <= last_move.next_max_move_size

        try:
            # return_val contains the new state, max_move_size ...
            #def run_one_step(validator_hash, validator, amount: int, move, max_move_size: int, mover_share, state, evidence, step_n: int,
                    #expected_move_type: MoveCode, on_chain: bool) -> MoveOrSlash:
            validator_info = validator_program_library[last_move.next_validator_hash]
            print(f"    ---- Running program {validator_info.name} ----")
            return_val: MoveOrSlash = run_one_step(
                game_environment, # amount
                script, # (move, mover_share, evidence, expected_move_type, on_chain)
                last_move, # (next_validator_hash, next_max_move_size, state)
                validator_info.program,
                expected_move_type)
        except Exception as e:
            traceback.print_exc()
            raise
        print(f"return_val='{return_val}'")
        if expected_move_type == MoveCode.SLASH:
            if len(remaining_script) > 0:
                run_game(game_environment, return_val, remaining_script[1:])
                # run_game(validator_program_library, amount, new_validation_program_hash, new_state, new_max_move_size, remaining_script[1:])
        if return_val.move_code == MoveCode.SLASH:
            # Done with run, we got slashed.
            # Figure out something to return from here when slashed.
            return

        # It's a move, reassign it.
        last_move = return_val


def bitfield_to_byte(x):
    v = 0
    xp = x
    xp.reverse()
    for bit in xp:
        v = (v << 1) | bit
        # print(bit, v)
    b = bytes(v)
    #assert(len(b) == 1)
    return b[-1:]

def test_run_a():
    alice_seed = b"0alice6789abcdef"
    bob_seed = b"0bob456789abcdef"
    #alice_bitfield = [0, 0, 0, 0, 1, 1, 1, 1]
    #bob_bitfield = [1, 0, 1, 0, 1, 0, 1, 0]
    alice_picks_byte = 0b01010101.to_bytes(1, byteorder='big') #bitfield_to_byte(alice_bitfield)
    bob_picks_byte = 0b10101010.to_bytes(1, byteorder='big') #bitfield_to_byte(bob_bitfield)
    print(f"ALICE PICKS: {alice_picks_byte} BOB PICKS: {bob_picks_byte}")
    amount = 200

    entropy_values = [
        bytes.fromhex("eb04c21e3ee58d1b494e0b5be68ee5e5ae5d4b7a0a01287005ff21e7b70c5ddc"),
        bytes.fromhex("ce173df1d1a7f2854f87d48cee0b17ac59dfad7b3d7ca077009b84808ae25b20"),
        bytes.fromhex("2b0433e13d49320ef10de4025b793b33df30ead99660f49b4dd4d11c836a407e"),
        bytes.fromhex("55218743c4fd53281f871d079483ace7cbf92d0e269093c23febd9f5e1b0dd44"),
        bytes.fromhex("5dec7b7c6c954f9f256900d7f67f2ab0b51f98ae7ee7bd71831eab4d62193b54")
    ]

    preimage = entropy_values[0][:16]
    alice_image = sha256(preimage).digest()
    bob_seed = entropy_values[1][:16]
    alice_picks_salt = entropy_values[2][:16]

    step_a = load_clvm(calpoker_clsp_dir / "a", recompile=False)
    step_a_hash = step_a.get_tree_hash()
    print("\nstep_a_hash and hash returned:")
    print(step_a_hash)

    # Move list entries:
    # (move, mover_share, evidence, expected_slash, on_chain)
    first_move = sha256(alice_seed).digest()

    # [43, 4, 51, 225, 61, 73, 50, 14, 241, 13, 228, 2, 91, 121, 59, 51, 170, 205]
    bob_selects_byte = bytes([205])

    move_list = [
        (first_move, 0, None, MoveCode.MAKE_MOVE, False),
        (bob_seed, 0, None, MoveCode.MAKE_MOVE, False),
        (alice_seed + sha256(alice_picks_salt + alice_picks_byte).digest(), 0, None, MoveCode.MAKE_MOVE, False),
        (bob_picks_byte, 0, None, MoveCode.MAKE_MOVE, False),
        (alice_picks_salt + alice_picks_byte + bob_selects_byte, 0, None, MoveCode.MAKE_MOVE, False)
    ]
    env = GameEnvironment(validator_program_library, amount)
    #move_zero = Move(step_a_hash, None, 32,)
    move_zero = Move(MoveCode.MAKE_MOVE, next_validator_hash=step_a_hash, state = Program.to(0), next_max_move_size=len(step_a_hash), extra_data=Program.to(0))
    run_game(env, move_zero, move_list)


# types/blockchain_format/program.py:21:class Program(SExp):

test_run_a()

"""
A alice_commit
    alice_commit
B bob_seed
    alice_commit bob_seed
C alice_reveal alice_picks_commit
    (alice_cards bob_cards) alice_picks_commit
D bob_picks
    bob_picks alice_cards bob_cards alice_picks_commit
E alice_picks_reveal alice_selects

Pass tests

slash succeed tests
    A
        Alice commit wrong length
    B
        Bob seed wrong length
    C
        move wrong length
        alice reveal doesn't match
    D
        move wrong length
        bob picks too few/too many cards
    E
        move wrong length
        alice picks reveal doesn't match
        alice picks wrong number of cards
        alice selects wrong number of cards

slashing fail tests
    nil evidence should not assert fail except for on E

    on E nil evidence should not fail when evidence is nil and waiter_puzzle_hash is nil
    on E nil evidence should fail when evidence is nil and waiter_puzzle_hash is non-nil
    on E should fail if bob selects too many cards (counter against bad alice hand)"""



# GTG -> no slash
# Alice picks good cards (a high hand)
# We expect Bob not to slash
















'''

factorial = (
    "ff02ffff01ff02ff02ffff04ff02ffff04ff05ff80808080ffff04ffff01ff02"
    + "ffff03ffff09ff05ffff010180ffff01ff0101ffff01ff12ff05ffff02ff02ff"
    + "ff04ff02ffff04ffff11ff05ffff010180ff808080808080ff0180ff018080"
)

factorial_function_hash = "de3687023fa0a095d65396f59415a859dd46fc84ed00504bf4c9724fca08c9de"
factorial_sym = {factorial_function_hash: "factorial"}


def a_test_simple_program_run() -> None:
    p = start_clvm_program(factorial, "ff0580", factorial_sym)

    last: Optional[Any] = None
    location: Optional[Any] = None

    while not p.is_ended():
        step_result = p.step()
        if step_result is not None:
            last = step_result
            assert "Failure" not in last

            if "Operator-Location" in last:
                location = last["Operator-Location"]

    assert last is not None
    assert location is not None
    if last is not None and location is not None:
        assert "Final" in last
        assert int(last["Final"]) == 120
        assert location.startswith("factorial")
'''
