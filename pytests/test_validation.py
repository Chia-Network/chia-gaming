from __future__ import annotations

from typing import Any, Optional
from pathlib import Path
from hashlib import sha256
from validator_hashes import program_hashes_hex
from clvm_tools_rs import start_clvm_program
from load_clvm import load_clvm

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

test_prog = load_clvm("test.clsp", include_standard_libraries=True, recompile=True)

class Turn(Enum):
    TURN_A = 1
    TURN_B = 2
    TURN_C = 3
    TURN_D = 4
    TURN_E = 5


calpoker_clsp_dir = Path("../clsp/onchain/calpoker/")

# List of validator program names, sans "clsp" extension
prog_names = ["a", "b", "c", "d", "e"]

def create_validator_program_library():
    # TODO: Use the clsp feature that exports module hash
    lib = {}
    for hex_key, prog_name in zip(program_hashes_hex, prog_names):
        lib[bytes.fromhex(hex_key)] = load_clvm(calpoker_clsp_dir / prog_name, recompile=False)
    # TODO: sanity check step_a_hash = step_a.get_tree_hash()
    return lib

calpoker_validator_programs = create_validator_program_library()
print("calpoker_validator_programs", calpoker_validator_programs)

# validator_mod_hash
# replacements: pass in values that you want to set to non-default values
def compose_validator_args(validator_mod_hash, replacements):
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




#def test_validate_picks():
# 1. Pass in initial state and a series of moves
# 2. Call the next validation program with (move, movershare) for that turn
# 3. Save return values to be passed on
# Check that we got "Not slash" as expected, new mover puzzle hash, and the



class MoveCode(Enum):
    MAKE_MOVE = 0
    ACCEPT = 1
    SLASH = 2
    TIMEOUT = 3
    SLASHED = 4
    TIMEDOUT = 5

"""
(mod_hash
    (MOVER_PUZZLE_HASH WAITER_PUZZLE_HASH TIMEOUT AMOUNT MOD_HASH NONCE
        MOVE MAX_MOVE_SIZE VALIDATION_INFO_HASH MOVER_SHARE PREVIOUS_VALIDATION_INFO_HASH)
        previous_state previous_validation_program mover_puzzle solution evidence)

"""

def print_validator_input_args(args):
    validator_arg_names = [
        "validator_hash",
        "arglist",
        "previous_state", "previous_validation_program", "mover_puzzle", "solution", "evidence"]
    print ("PYTHON INPUT ARGS: ")
    for name, arg in zip(validator_arg_names, args):
        print(f"{name}: {arg}")
    print ("CLVM INPUT ARGS: ")
    print(Program.to(args))

def print_validator_output(args):
    output_names = [ "move_type", "next_program_hash" ]
    print("VALIDATOR OUTPUT:")
    for name, arg in zip(output_names, args):
        print(f"    {name}: {arg}")

def run_one_step(validator_hash, validator, amount: int, move, max_move_size: int, mover_share, state, evidence, step_n: int,
                 expected_slash: bool = False, on_chain: bool = False):
    # convert args & curry, etc

    assert(expected_slash == False or expected_slash == True, expected_slash)
    # TODO: See if compose_validator_args will save code later XOR delete
    # WAITER_PUZZLE_HASH doubles as an "on_chain" indicator
    args = [validator_hash,
                            [None, on_chain, None, amount, None, None,
                            move, max_move_size, None, mover_share, None],
                            state, validator, None, None, evidence]
    #print(f"VALIDATOR ARGS FOR '{prog_names[step_n]}'")
    #print_validator_input_args(args) # problem here running e: can't cast 5-tuple to SExp

    try:
        # print("VALIDATOR first bytes: ", bytes(validator)[:32])
        # largs = list
        print("ARGS", args)
        ret_val = validator.run(args)
    except Exception as e:
        print(e)
        assert(not expected_slash)
        return None
    # print(f"OUTPUT OF validator.run() is:")
    # print("    (move_type, a, b, c)")
    # print(f"    {ret_val.as_python()}")
    print_validator_output(ret_val.as_python())
    
    foo = ret_val.as_python()
    (move_type, a, *_) = foo
    if move_type == MoveCode.SLASH:
        assert(expected_slash)
        return a
    else:
        assert(not expected_slash)
        return foo[1:]

def run_game(validator_program_library, amount, validator_hash, state, max_move_size: int, remaining_script: List, n=0):
    print(f"111 {validator_program_library}")
    # print(f"XXX {remaining_script}")
    if isinstance(remaining_script[0][0], list):
        for t in remaining_script[0]:
            run_game(validator_program_library, amount, validator_hash, state, max_move_size, t, n+1)
        return

    (move, mover_share, evidence, expected_slash, on_chain, *rest_of_args) = remaining_script[0]
    print(f"\n    ---- Step {n}: ----")
    print(f"""
        remaining_script: {remaining_script}
        remaining_script[0]: {remaining_script[0]}
        move={move}
        max_move_size={max_move_size}
        mover_share={mover_share}
        evidence={evidence}
        on_chain={on_chain}
        rest_of_args={rest_of_args}""")
    assert len(move) <= max_move_size

    try:
        #validator_hash, validator, amount, move, max_move_size, mover_share, state, evidence, step_n, expected_slash: bool, on_chain: bool 
        return_val = run_one_step(validator_hash, validator_program_library[validator_hash], amount, move, max_move_size, mover_share, state, evidence, n, expected_slash, on_chain)
    except Exception as e:
        traceback.print_exc()
        raise
    print(f"full_return_val='{return_val}'")
    if not expected_slash:
        (new_validation_program_hash, new_state, new_max_move_size, *_) = return_val
        new_max_move_size = int.from_bytes(new_max_move_size)
        print(f"YYY (new_validation_program_hash, new_state, new_max_move_size) = {(new_validation_program_hash, new_state, new_max_move_size)}")
        if len(remaining_script) > 1:
            run_game(validator_program_library, amount, new_validation_program_hash, new_state, new_max_move_size, remaining_script[1:], n+1)


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
    alice_picks_byte = 0b00001111.to_bytes(1, byteorder='big') #bitfield_to_byte(alice_bitfield)
    bob_picks_byte = 0b10101010.to_bytes(1, byteorder='big') #bitfield_to_byte(bob_bitfield)    
    print(f"ALICE PICKS: {alice_picks_byte} BOB PICKS: {bob_picks_byte}")
    alice_picks_salt = b"alice_picks_salt"

    step_a = load_clvm(calpoker_clsp_dir / "a", recompile=False)
    step_a_hash = step_a.get_tree_hash()
    print("\nstep_a_hash and hash returned:")
    print(step_a_hash)

    # Move list entries:
    # (move, mover_share, evidence, expected_slash, on_chain)
    fake_move = alice_seed + bob_seed
    first_move = sha256(alice_seed).digest()

    alice_good_selections = b'a'
    alice_bad_selections = b'a'
    bob_good_selections = b'a'
    bob_bad_selections = b'a'

    '''
    Alice Win, Tie, Lose is in mover_share
    Tie is 100
    Third column is bob hand selection ([G]ood or [B]ad
GTG -> no slash
GAG -> slash (Alice wins = A)
GTB -> no slash
GAB -> no slash
BAG -> slash
BTG -> slash
    '''
    move_list = [
        (first_move, 0, None, False, False),
        (bob_seed, 0, None, False, False),
        (alice_seed + sha256(alice_picks_salt + alice_picks_byte).digest(), 0, None, False, False),
        (bob_picks_byte, 0, None, False, False),
        [
            # Slash succeed cases
            (alice_picks_salt + alice_picks_byte + alice_good_selections, 100, bob_good_selections, False, False),
            (alice_picks_salt + alice_picks_byte + alice_good_selections, 0, bob_good_selections, True, False),
            (alice_picks_salt + alice_picks_byte + alice_good_selections, 100, bob_bad_selections, False, False),
            (alice_picks_salt + alice_picks_byte + alice_good_selections, 0, bob_bad_selections, False, False),
            (alice_picks_salt + alice_picks_byte + alice_bad_selections, 0, bob_good_selections, True, False),
            (alice_picks_salt + alice_picks_byte + alice_bad_selections, 100, bob_good_selections, True, False),
            # Slash fail cases
            (alice_picks_salt + alice_picks_byte + alice_good_selections, 100, None, True, False ), # The game proceeds as expected, until Bob sends nil evidence. But we are off-chain (waiter_puzzle_hash == nil), so no slash-fail # TODO: We need to also check that the program does not assert fail i.e. does not run "(x)"
            (alice_picks_salt + alice_picks_byte + alice_good_selections, 100, None, False, True), # The game proceeds as expected, until Bob sends nil evidence. waiter_puzzle_hash is not nil (we are on-chain). Slash Expected.
            (alice_picks_salt + alice_picks_byte + alice_bad_selections, 100, chr(0xff), False, False), # The game proceeds as expected, until step E. Alice
        ]
        ]
        
    
    run_game(calpoker_validator_programs, 200, step_a_hash, None, 32, move_list)

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
