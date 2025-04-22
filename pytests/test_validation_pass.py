from __future__ import annotations

import json
import subprocess
import traceback
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

from clvm_tools_rs import start_clvm_program

from clvm_types.program import Program
from clvm_types.sized_bytes import bytes32
from load_clvm_hex import load_clvm_hex
from seed import GameSeed
from util import (TestCaseSequence, ValidatorInfo, bitfield_to_byte,
                  calpoker_clsp_dir, dbg_assert_eq, prog_names, read_test_case,
                  TestCaseAlternative, load_clvm_hex)
from validator_hashes import program_hashes_hex
from validator_output import Move, MoveCode, MoveOrSlash, Slash
from validator import GameEnvironment, create_validator_program_library, run_validator

# TODO: check returned/next max_move size value

# Note: WAITER_PUZZLE_HASH == nil, signifying off-chain

# non-nil vars for tests in a.clsp:
# AMOUNT MOVE MAX_MOVE_SIZE MOVER_SHARE
# previous_state evidence

# previous_state is hash-checked against a value that *IS* curried-in
# e.clsp: evidence == nil (off chain)
# e.clsp: evidence == bob's selections (on-chain)

# TODO: Generate initial state & initial moves

def create_validator_program_library():
    """
    Gather CalPoker validator progarms and their hashes, allowing us to check the hash
    that is output as the next validation program hash (called "bhash" in {a,b,c,d,e}.clsp)
    """
    # TODO: Use the clsp feature that exports module hash
    lib = {}
    for hex_key, prog_name in zip(program_hashes_hex, prog_names):
        lib[bytes.fromhex(hex_key)] = ValidatorInfo(load_clvm_hex(calpoker_clsp_dir / f"{prog_name}.hex"), prog_name)
    # TODO: sanity check step_a_hash = step_a.get_tree_hash()
    return lib

validator_program_library = create_validator_program_library()

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

#def test_validate_discards():
# 1. Pass in initial state and a series of moves
# 2. Call the next validation program with (move, movershare) for that turn
# 3. Save return values to be passed on
# Check that we got "Not slash" as expected, new mover puzzle hash, and the


def byte_from_indices(indices):
    res = 0
    for i in indices:
        res |= (1 << i)
    return res

@dataclass
class CLVMExceptionInformation:
    message: str
    hexstr: str
    def __repr__(self):
        return f"""
    {self.message}
    {self.hexstr}
    {Program.fromhex(self.hexstr).as_python()}
"""

# def run_game(validator_program_library, amount, validator_hash, state, max_move_size: int, remaining_script: List, n=0):
def run_game(game_environment: GameEnvironment, last_move: Move, max_move_size_from_last_turn: int, script, indent=0, path=''):
    if isinstance(script, TestCaseSequence):
        for j, raw_element in enumerate(script.sequence):
            use_path = f'{path}{j}.'
            element = raw_element
            last_move = run_game(game_environment, last_move, max_move_size_from_last_turn, element, indent=indent + 2, path=use_path)
            print(f'sequence: last_move {last_move}')
            # We must be on the last move if no further action is possible.
            if last_move is None:
                assert j == len(script.sequence) - 1
                return

    elif isinstance(script, TestCaseAlternative):
        for j, raw_element in enumerate(script.alternatives):
            use_path = f'{path} alternative {j}.'
            element = raw_element
            run_game(game_environment, last_move, max_move_size_from_last_turn, element, indent=indent + 2, path=use_path)
    else:
        print("SCRIPT IS", script)
        # ENV: validator_program_library, amount,
        # MOVE: validator_hash, state, max_move_size,
        # t, n+1
        (move, mover_share, evidence, expected_move_type, on_chain, name, *rest_of_args) = script
        print(f"""
            expected_move_type={expected_move_type}
            move={move}
            max_move_size={last_move.next_max_move_size}
            mover_share={mover_share} # How much the player who is currently moving *would get* if the game is ended - comes from handler
            evidence={evidence}
            on_chain={on_chain}
            rest_of_args={rest_of_args}
        """)
        # assert len(move) <= last_move.next_max_move_size

        # return_val contains the new state, max_move_size ...
        #def run_one_step(validator_hash, validator, amount: int, move, max_move_size: int, mover_share, state, evidence, step_n: int,
        #expected_move_type: MoveCode, on_chain: bool) -> MoveOrSlash:

        if last_move.next_validator_hash is None:
            return

        validator_info = validator_program_library[last_move.next_validator_hash]
        print(f'comparing validator name {validator_info.name} to expected {script[-1]}')
        assert validator_info.name == script[-1]
        print(f"    ---- step {path} Running program {validator_info.name} ----")

        try:
            return_val: MoveOrSlash = run_one_step(
                game_environment, # amount
                script, # (move, mover_share, evidence, expected_move_type, on_chain)
                last_move, # (next_validator_hash, next_max_move_size, state)
                validator_info.program,
                expected_move_type
            )
        except Exception as e:
            if expected_move_type == MoveCode.CLVM_EXCEPTION:
                # Note: clvm throws ValueError as of 2025 April 18
                # But, we always expect a Tuple from a clean CLVM invocation
                if isinstance(e.args, tuple):
                    # print(e)
                    print(CLVMExceptionInformation(*e.args))
                    # Completed test sucessfully - received the expected exception
                    return
            raise e

        print(f"return_val='{return_val}'")

        if return_val.move_code == MoveCode.SLASH:
            # Done with run, we got slashed.
            # Figure out something to return from here when slashed.
            return

        max_move_size_from_last_turn = return_val.next_max_move_size

        # It's a move, reassign it.
        return return_val



def substitute_selections(test_inputs, ):
    pass

def generate_test_set(test_inputs: Dict):
    alice_good_selections = test_inputs["alice_good_selections"]

    '''
        "seed": int_seed,
        "alice_discards": alice_discards,
        "bob_discards": bob_discards,
        # selects in the format of "move" in the validation programs
        "alice_good_selections": alice_selects, # ???
        "bob_good_selections": bob_selects, # ???
        "alice_loss_selections": alice_loss_selects,
        "bob_loss_selections": bob_loss_selects,
    '''

    seed = GameSeed(test_inputs['seed'])
    preimage = seed.alice_seed
    alice_image = sha256(preimage).digest()
    alice_discards_salt = seed.seed[:16]
    first_move = sha256(seed.alice_seed).digest()
    alice_discards_byte = bitfield_to_byte(test_inputs['alice_discards'])
    bob_discards_byte = bitfield_to_byte(test_inputs['bob_discards'])
    alice_good_selections = bitfield_to_byte(test_inputs['alice_good_selections'])
    alice_loss_selections = bitfield_to_byte(test_inputs['alice_loss_selections'])
    bob_good_selections = bitfield_to_byte(test_inputs['bob_good_selections'])
    bob_loss_selections = bitfield_to_byte(test_inputs['bob_loss_selections'])

    print(bob_discards_byte)

    too_few_discards = 0b00000111.to_bytes(1, byteorder='big')
    too_many_discards = 0b00111111.to_bytes(1, byteorder='big')
    too_few_selections = 0b00001111.to_bytes(1, byteorder='big')
    too_many_selections = 0b00111111.to_bytes(1, byteorder='big')

    first_move_too_short = first_move[1:]
    first_move_too_long = first_move + b"b"

    bob_seed_wrong_too_long = seed.bob_seed + b"a"
    bob_seed_wrong_too_short = seed.bob_seed[1:]

    good_c_move = seed.alice_seed + sha256(alice_discards_salt + alice_discards_byte).digest()
    c_move_too_short = good_c_move[1:]
    c_move_too_long = good_c_move + b"b"
    alice_bad_seed = b'0' * 16
    c_move_bad_alice_reveal_move = alice_bad_seed + sha256(alice_discards_salt + alice_discards_byte).digest()

    d_move_too_short = b''
    d_move_too_long = b'ab'
    d_move_too_few_bits_set = 0b00000111.to_bytes(1, byteorder='big')
    d_move_too_many_bits_set = 0b00011111.to_bytes(1, byteorder='big')

    # (alice_discards_salt + alice_discards_byte + alice_good_selections, 100, bob_good_selections, MoveCode.MAKE_MOVE, False, 'e'),
    e_move = alice_discards_salt + alice_discards_byte + alice_good_selections
    e_move_too_short = e_move[1:]
    e_move_too_long = e_move + b'a'
    e_move_bad_reveal = alice_discards_salt + alice_discards_byte + b'\0x00'
    e_move_too_few_discards = alice_discards_salt + too_few_discards + alice_good_selections
    e_move_too_many_discards = alice_discards_salt + too_many_discards + alice_good_selections
    e_move_too_few_selections = alice_discards_salt + alice_discards_byte + too_few_selections
    e_move_too_many_selections = alice_discards_salt + alice_discards_byte + too_many_selections

    slash_succeed_tests = TestCaseAlternative([
        TestCaseAlternative([
            # a.clsp tests
            (first_move_too_short, 0, None, MoveCode.SLASH, False, 'a'),
            (first_move_too_long, 0, None, MoveCode.SLASH, False, 'a'),
        ]),
        # b.clsp tests
        TestCaseSequence([
            (first_move, 0, None, MoveCode.MAKE_MOVE, False, 'a'),
            TestCaseAlternative([
                (bob_seed_wrong_too_short, 0, None, MoveCode.SLASH, False, 'b'),
                (bob_seed_wrong_too_long, 0, None, MoveCode.SLASH, False, 'b')
            ])
        ]),
        # c.clsp tests
        TestCaseSequence([
            (first_move, 0, None, MoveCode.MAKE_MOVE, False, 'a'),
            (seed.bob_seed, 0, None, MoveCode.MAKE_MOVE, False, 'b'),
            TestCaseAlternative([
                (c_move_too_short, 0, None, MoveCode.SLASH, False, 'c'),
                (c_move_too_long, 0, None, MoveCode.SLASH, False, 'c'),
                # alice reveal doesn't match
                (c_move_bad_alice_reveal_move, 0, None, MoveCode.SLASH, False, 'c'),
            ])
        ]),
        # d.clsp tests
        TestCaseSequence([
            (first_move, 0, None, MoveCode.MAKE_MOVE, False, 'a'),
            (seed.bob_seed, 0, None, MoveCode.MAKE_MOVE, False, 'b'),
            (good_c_move, 0, None, MoveCode.MAKE_MOVE, False, 'c'),
            TestCaseAlternative([
                # move wrong length
                (d_move_too_short, 0, None, MoveCode.SLASH, False, 'd'),
                (d_move_too_long, 0, None, MoveCode.SLASH, False, 'd'),

                # bob picks too few/too many cards
                (d_move_too_few_bits_set, 0, None, MoveCode.SLASH, False, 'd'),
                (d_move_too_many_bits_set, 0, None, MoveCode.SLASH, False, 'd'),
            ])
        ]),
        # e.clsp
        TestCaseSequence([
            (first_move, 0, None, MoveCode.MAKE_MOVE, False, 'a'),
            (seed.bob_seed, 0, None, MoveCode.MAKE_MOVE, False, 'b'),
            (good_c_move, 0, None, MoveCode.MAKE_MOVE, False, 'c'),
            (bob_discards_byte, 0, None, MoveCode.MAKE_MOVE, False, 'd'),
            TestCaseAlternative([
                # move wrong length
                (e_move_too_short, 100, bob_good_selections, MoveCode.SLASH, False, 'e'),
                (e_move_too_long, 100, bob_good_selections, MoveCode.SLASH, False, 'e'),

                # alice picks reveal doesn't match
                (e_move_bad_reveal, 100, bob_good_selections, MoveCode.SLASH, False, 'e'),
                # alice discards wrong number of cards
                (e_move_too_few_discards, 100, bob_good_selections, MoveCode.SLASH, False, 'e'),
                (e_move_too_many_discards, 100, bob_good_selections, MoveCode.SLASH, False, 'e'),
                # alice selects wrong number of cards
                (e_move_too_few_selections, 100, bob_good_selections, MoveCode.SLASH, False, 'e'),
                (e_move_too_many_selections, 100, bob_good_selections, MoveCode.SLASH, False, 'e')
            ])
        ])
    ])

    recursive_list_up_to_d = [
        (first_move, 0, None, MoveCode.MAKE_MOVE, False, 'a'),
        (seed.bob_seed, 0, None, MoveCode.MAKE_MOVE, False, 'b'),
        (good_c_move, 0, None, MoveCode.MAKE_MOVE, False, 'c'),
        (bob_discards_byte, 0, None, MoveCode.MAKE_MOVE, False, 'd'),
        [
            # Slash succeed cases
            # state                                                       bob_payout,  bob selections,  expected_result, on_chain, validator
            (alice_discards_salt + alice_discards_byte + alice_good_selections, 100, bob_good_selections, MoveCode.MAKE_MOVE, False, 'e'),
            (alice_discards_salt + alice_discards_byte + alice_good_selections, 0, bob_good_selections, MoveCode.SLASH, False, 'e'),
            (alice_discards_salt + alice_discards_byte + alice_good_selections, 100, bob_loss_selections, MoveCode.MAKE_MOVE, False, 'e'),
            (alice_discards_salt + alice_discards_byte + alice_good_selections, 0, bob_loss_selections, MoveCode.MAKE_MOVE, False, 'e'),
            (alice_discards_salt + alice_discards_byte + alice_loss_selections, 0, bob_good_selections, MoveCode.SLASH, False, 'e'),
            (alice_discards_salt + alice_discards_byte + alice_loss_selections, 100, bob_good_selections, MoveCode.SLASH, False, 'e'),
            # Slash fail cases
            (alice_discards_salt + alice_discards_byte + alice_good_selections, 100, None, MoveCode.MAKE_MOVE, False, 'e'), # The game proceeds as expected, until Bob sends nil evidence. But we are off-chain (waiter_puzzle_hash == nil), so no slash-fail # TODO: We need to also check that the program does not assert fail i.e. does not run "(x)"
            (alice_discards_salt + alice_discards_byte + alice_good_selections, 100, None, MoveCode.CLVM_EXCEPTION, True, 'e'), # The game proceeds as expected, until Bob sends nil evidence. waiter_puzzle_hash is not nil (we are on-chain). Slash Expected.

            #
            (alice_discards_salt + alice_discards_byte + alice_loss_selections, 100, bytes([0xff]), MoveCode.CLVM_EXCEPTION, False, 'e'), # The game proceeds as expected, until step E. Alice
        ]
    ]

    wrong_alice_picks_count_tests = TestCaseSequence([
        (first_move, 0, None, MoveCode.MAKE_MOVE, False, 'a'),
        (seed.bob_seed, 0, None, MoveCode.MAKE_MOVE, False, 'b'),
        TestCaseAlternative([
            TestCaseSequence([
                (c_move_too_short, 0, None, MoveCode.SLASH, False, 'c'),
                # (bob_discards_byte, 0, None, MoveCode.MAKE_MOVE, False, 'd'),
                # (e_move_too_few_discards, 100, bob_good_selections, MoveCode.MAKE_MOVE, False, 'e'),
            ]),
            TestCaseSequence([
                (c_move_too_long, 0, None, MoveCode.SLASH, False, 'c'),
                # (bob_discards_byte, 0, None, MoveCode.MAKE_MOVE, False, 'd'),
                # (e_move_too_many_selections, 100, bob_good_selections, MoveCode.MAKE_MOVE, False, 'e'),
            ])
        ])
    ])

    return TestCaseAlternative([
        wrong_alice_picks_count_tests,
        slash_succeed_tests
    ])

def test_run_with_moves(move_list, amount):
    step_a = load_clvm_hex(calpoker_clsp_dir / "a.hex")
    step_a_hash = step_a.get_tree_hash()
    print("\nstep_a_hash and hash returned:")
    print(step_a_hash)

    env = GameEnvironment(validator_program_library, amount)
    #move_zero = Move(step_a_hash, None, 32,)
    move_zero = Move(MoveCode.MAKE_MOVE, next_validator_hash=step_a_hash, state = Program.to(0), next_max_move_size=len(step_a_hash), extra_data=Program.to(0))
    run_game(env, move_zero, 32, move_list)

def normal_outcome_move_list():
    alice_seed = b"0alice6789abcdef"
    bob_seed = b"0bob456789abcdef"
    #alice_bitfield = [0, 0, 0, 0, 1, 1, 1, 1]
    #bob_bitfield = [1, 0, 1, 0, 1, 0, 1, 0]
    alice_discards_byte = 0b01010101.to_bytes(1, byteorder='big') #bitfield_to_byte(alice_bitfield)
    bob_discards_byte = 0b10101010.to_bytes(1, byteorder='big') #bitfield_to_byte(bob_bitfield)
    print(f"ALICE PICKS: {alice_discards_byte} BOB PICKS: {bob_discards_byte}")
    amount = 200

    # [43, 4, 51, 225, 61, 73, 50, 14, 241, 13, 228, 2, 91, 121, 59, 51, 170, 205]
    bob_selects_byte = bytes([205])

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
    alice_discards_salt = entropy_values[2][:16]

    # Move list entries:
    # (move, mover_share, evidence, expected_slash, on_chain)
    first_move = sha256(alice_seed).digest()

    return [
        (first_move, 0, None, MoveCode.MAKE_MOVE, False),
        (bob_seed, 0, None, MoveCode.MAKE_MOVE, False),
        (alice_seed + sha256(alice_discards_salt + alice_discards_byte).digest(), 0, None, MoveCode.MAKE_MOVE, False),
        (bob_discards_byte, 0, None, MoveCode.MAKE_MOVE, False),
        (alice_discards_salt + alice_discards_byte + bob_selects_byte, 0, None, MoveCode.MAKE_MOVE, False)
    ]


def test_run_a():
    seed_case = read_test_case("seed.json")
    test_run_with_moves(generate_test_set(seed_case), seed_case["amount"])

    # test_run_with_moves(normal_outcome_move_list(), 200)

    # alice_good_selections = 0b01101110.to_bytes(1, byteorder='big')
    # alice_loss_selections = 0b10110011.to_bytes(1, byteorder='big')
    # bob_good_selections = 0b00011111.to_bytes(1, byteorder='big')
    # bob_loss_selections = 0b11111000.to_bytes(1, byteorder='big')



# def run_test_from_file(file):
#     inputs = read_test_case(file)



# types/blockchain_format/program.py:21:class Program(SExp):

test_run_a()

'''
A alice_commit
    alice_commit
B bob_seed
    alice_commit bob_seed
C alice_reveal alice_discards_commit
    (alice_cards bob_cards) alice_discards_commit
D bob_discards
    bob_discards alice_cards bob_cards alice_discards_commit
E alice_discards_reveal alice_selects

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
        bob discards too few/too many cards
    E
        move wrong length
        alice discards reveal doesn't match
        alice discards wrong number of cards
        alice selects wrong number of cards

slashing fail tests
    nil evidence should not assert fail except for on E

    on E nil evidence should not fail when evidence is nil and waiter_puzzle_hash is nil
    on E nil evidence should fail when evidence is nil and waiter_puzzle_hash is non-nil
    on E should fail if bob selects too many cards (counter against bad alice hand)"""



# GTG -> no slash
# Alice discards good cards (a high hand)
# We expect Bob not to slash


















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
