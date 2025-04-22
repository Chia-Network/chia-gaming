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
                  calpoker_clsp_dir, dbg_assert_eq, prog_names, read_test_case)
from validator_hashes import program_hashes_hex
from validator_output import Move, MoveCode, MoveOrSlash, Slash
from validator import GameEnvironment, create_validator_program_library, run_validator

from calpoker import Card

"""
test_handlers.py:

Test off-chain chialisp.
"""

# calpoker_generate.clinc
calpoker_clsp_dir = Path("../clsp/")
calpoker_factory = load_clvm_hex(calpoker_clsp_dir / "calpoker_include_calpoker_factory.hex")

# (i_am_initiator my_contribution their_contribution params)

I_AM_INITIATOR = 1  # I am "Alice"
calpoker_factory_alice = calpoker_factory.run([I_AM_INITIATOR, 100, 100, None])
calpoker_handler_alice_data = Program.to(calpoker_factory_alice).as_python()
our_info = calpoker_handler_alice_data[0]
calpoker_factory_bob = calpoker_factory.run([not I_AM_INITIATOR, 100, 100, None])
calpoker_handler_bob_data = Program.to(calpoker_factory_bob).as_python()
bob_info = calpoker_handler_bob_data[0]

#handlers = None
# data: 2-5, 7,8
# programs: list elements 0 & 1
dataf = {
    0: "amount",
    1: "is_my_turn",
    2: "handler_program",
    3: "my_contribution",
    4: "their_contribution",
    5: "initial_validation_program",
    6: "initial_validation_program_hash",  # first validation program hash
    7: "initial_state",
    8: "initial_move",
    9: "initial_max_move_size",
    10: "initial_mover_share"
}

# our_data = [x for i,x in enumerate(our_info) if i in [2,3,4,6,7]]
our_data = { name:our_info[index] for index,name in dataf.items() }
bob_data = { name:bob_info[index] for index,name in dataf.items() }

def print_dict(d):
    for k,v in d.items():
        print(f"    {k,v}")

print_dict(our_data)
first_handler = Program.to(our_data["handler_program"])

# run alice's handler -> move
# run alice's validator -> readable
# bob moves ->
# handlers only consume an "our move". They may return an advisory SLASH
# handler produces a list of "evidences"
# Validators now produce all game state
# handcalc is called off-chain. It is a heavy operation. We then pass that info on

# handler_args = (new_move, amount, last_mover_share, last_max_move_size, entropy)
# Program.to(our_data["handler_program"]).run()

@dataclass
class MyTurnHandlerResult:
    move_bytes: bytes
    validator_for_my_move: Program  # validator to run for this move: the move that our handler will produce
    validator_for_my_move_hash: bytes32
    validator_for_their_next_move: Program
    validator_for_their_move_hash: bytes32
    max_move_size: int  # (for bob) TODO: remove this param?
    new_mover_share: int  # TODO: remove this param?
    their_turn_handler: Program  # If we are Alice, this is the newly parameterized program that will recv Bob's move

def call_my_turn_handler(handler: Program, local_move, amount, split, entropy):
    "Mover handler"
    ret = handler.run([local_move, amount, split, entropy])
    return MyTurnHandlerResult(*ret.as_python())

@dataclass
class TheirTurnHandlerArgs:
    amount: int
    state: Program
    move: bytes
    validation_program_hash: bytes32
    mover_share: int
    def as_clvm(self):
        return Program.to([self.amount, self.state, self.move, self.validation_program_hash, self.mover_share])

@dataclass
class TheirTurnHandlerResult:
    kind: int
    readable_move: Program
    my_turn_handler: Program
    message: bytes

    def __init__(self, kind, readable_move, my_turn_handler, message=None):
        self.kind = kind
        self.readable_move = readable_move
        self.my_turn_handler = my_turn_handler
        self.message = message

def call_their_turn_handler(handler, args: TheirTurnHandlerArgs):
    "Waiter handler"
    ret = handler.run(args.as_clvm())
    return TheirTurnHandlerResult(*ret.as_python())

# my turn: alice a,c,e # we have the current game state locally in "my_turn" handlers
# (local_move amount split entropy)

# their turn: bob a,c,e == (alice b,d)
# (amount (@ state (bob_discards alice_selects alice_cards bob_cards alice_hand_value)) move validation_program_hash split)

# a.clsp will be run by both Alice & Bob: this implies Bob ha a special case during his first move

entropy = sha256(b"1").digest()
# ret =  MyTurnHandlerResult(*call_my_turn_handler(first_handler, 0, 200, 0, entropy).as_python())
# print(ret)

def print_step():
    pass


def get_happy_path(test_inputs: Dict):
    seed = GameSeed(test_inputs['seed'])
    preimage = seed.alice_seed
    alice_image = sha256(preimage).digest()
    alice_discards_salt = seed.seed[:16]
    first_move = sha256(seed.alice_seed).digest()
    alice_discards_byte = bitfield_to_byte(test_inputs['alice_discards'])
    good_c_move = seed.alice_seed + sha256(alice_discards_salt + alice_discards_byte).digest()
    bob_discards_byte = bitfield_to_byte(test_inputs['bob_discards'])
    alice_good_selections = bitfield_to_byte(test_inputs['alice_good_selections'])
    # alice_loss_selections = bitfield_to_byte(test_inputs['alice_loss_selections'])
    bob_good_selections = bitfield_to_byte(test_inputs['bob_good_selections'])
    e_move = alice_discards_salt + alice_discards_byte + alice_good_selections

    # All 8 cards initially shown to each player (pre discards and picks)
    alice_all_cards = [Card(rank=2, suit=2), Card(rank=5, suit=3), Card(rank=8, suit=2), Card(rank=11, suit=3), Card(rank=14, suit=1), Card(rank=14, suit=2), Card(rank=14, suit=3), Card(rank=14, suit=4)]
    bob_all_cards = [Card(rank=3, suit=3), Card(rank=4, suit=1), Card(rank=5, suit=4), Card(rank=8, suit=1), Card(rank=8, suit=3), Card(rank=8, suit=4), Card(rank=12, suit=2), Card(rank=12, suit=3)]

    alice_all_cards = [card.as_list() for card in alice_all_cards]
    bob_all_cards = [card.as_list() for card in bob_all_cards]
    d_results = [bob_discards, alice_selects, bob_selects, alice_hand_value, bob_hand_value]
    e_results = [alice_discards, alice_selects, bob_selects, alice_hand_value, bob_hand_value]
    alice_initial_handler = None  # my_turn_handler
    bob_initial_handler = None    # their_turn_handler


    # Note: possible todo: display the initial_state in a compatible format

    happy_path = [
        # our_readable, entropy, move, mover_share, their_readable
        (None, entropy, first_move, 0, None),
        (None, entropy, seed.bob_seed, 0, [alice_all_cards, bob_all_cards]),
        (alice_discards_byte, entropy, good_c_move, 0, [alice_all_cards, bob_all_cards]),
        (bob_discards_byte, entropy, bob_discards_byte, 0, d_results),
        (None, entropy, e_move, 100, e_results)
    ]
    return TestCaseSequence(happy_path)

def run_game(state: S, move_list, mover_handler, waiter_handler):
    pass

validator_program_library = create_validator_program_library()

@dataclass
class GameRuntimeInfo:
    state: Program
    move: bytes
    max_move_size: int
    mover_share: int

class Player:
    def __init__(
            self,
            whose_turn,
            initial_turn_handler,
            initial_their_turn_validator,
            their_turn_vp_hash,
            state,
            amount
    ):
        self.state = state
        self.amount = amount

        if whose_turn:
            self.my_turn_handler = initial_turn_handler
            self.their_turn_handler = None
        else:
            self.my_turn_handler = None
            self.their_turn_handler = initial_turn_handler

        self.their_turn_validator = initial_their_turn_validator
        self.their_turn_validation_program_hash = their_turn_vp_hash

    def run_my_turn(self, env, move):
        # My Turn
        local_move, entropy, wire_move, mover_share, their_readable = move
        my_turn_result = call_my_turn_handler(
            self.my_turn_handler,
            local_move,
            amount,
            split,
            entropy
        )

        assert my_turn_result.move_bytes == wire_move
        assert my_turn_result.new_mover_share == mover_share

        self.their_turn_validator = my_turn_result.validator_for_their_move
        self.their_turn_validation_program_hash = my_turn_result.validator_for_their_move_hash

        validator_result = run_validator(
            env,
            (wire_move, mover_share, None, None, False),
            (my_turn_result.validator_for_their_move_hash, self.state.state),
            None,
        )

        assert validator_result.move_code == MoveCode.MAKE_MOVE, f"Expected to make move, but got {validator_result.move_code}"

        self.state = GameRuntimeInfo(
            validator_result.state,
            move.my_turn_result.move_bytes,
            my_turn_result.max_move_size,
            my_turn_result.mover_share
        )

        self.their_turn_handler = my_turn_result.their_turn_handler

    def run_their_turn(self, env, move_bytes, mover_share, expected_readable_move):
        validator_result = run_validator(
            env,
            (move_bytes, mover_share, None, None, False),
            (self.their_turn_validation_program_hash, self.state.state),
        )
        their_turn_result = call_their_turn_handler(
            self.their_turn_handler,
            TheirTurnHandlerArgs(
                self.amount,
                self.state.state,
                move_bytes,
                self.validation_program_hash,
                self.state.new_mover_share
            )
        )
        assert their_turn_result.kind == MoveCode.MAKE_MOVE.value
        assert expected_readable_move == their_turn_result.readable_move

        self.my_turn_handler = their_turn_result.my_turn_handler

def test_run_with_moves(game_runtime_info, move_list, amount):
    # step_a = load_clvm_hex(calpoker_clsp_dir / "a.hex")
    # step_a_hash = step_a.get_tree_hash()
    # print("\nstep_a_hash and hash returned:")
    # print(step_a_hash)

    env = GameEnvironment(validator_program_library, amount)
    #move_zero = Move(step_a_hash, None, 32,)
    # move_zero = Move(MoveCode.MAKE_MOVE, next_validator_hash=step_a_hash, state = Program.to(0), next_max_move_size=len(step_a_hash), extra_data=Program.to(0))
    # run_game(s, env, move_zero, 32, move_list)

    # run
    alice_my_handler = our_data["handler"]
    bob_their_handler = bob_data["handler"]

    players = [
        Player(
            True,
            our_data["handler"],
            our_data["initial_validation_program"],
            our_data["initial_validation_program_hash"],
            state,
            amount
        ),
        Player(
            False,
            bob_data["handler"],
            bob_data["initial_validation_program"],
            bob_data["initial_validation_program_hash"],
            state,
            amount
        )
    ]
    whose_move = 0

    for move in move_list:
        players[whose_move].run_my_turn(
            env,
            move,
        )

        whose_move = whose_move ^ 1
        players[whose_move].run_their_turn(
            env,
            move[2], # wire move
            move[3], # mover share
            move[-1] # their readable
        )

def run_test():
    seed_case = read_test_case("seed.json")
    test_case = get_happy_path(seed_case)
    game_runtime_info = GameRuntimeInfo(*our_info[7:])
    test_run_with_moves(game_runtime_info, test_case, 200)

def decode_end_move(d: Program):
    pass

# Protocol arg shape types
# class Test

# we don't share state, we both sep. compute it identically
handler_test_0 = [
    # initial state, alice_handler, alice_handler_args(move, entropy), alice_validator
    # state, bob validator(alice_move) --(state)--> bob_their_turn_handler --readable move-->,
    # we never get state from bob
    # bob_move run alice_next_validator()
]

