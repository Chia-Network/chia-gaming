from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union
from enum import Enum

from chialisp import start_clvm_program

from calpoker import Card
from chia_gaming.clvm_types.program import Program
from chia_gaming.util.sized_bytes import bytes32
from chia_gaming.clvm_types.load_clvm_hex import load_clvm_hex
from seed import GameSeed
from util import (
    TestCaseSequence,
    ValidatorInfo,
    bitfield_to_byte,
    calpoker_clsp_dir,
    dbg_assert_eq,
    read_test_case,
    validator_program_filenames,
)
from validator import GameEnvironment, create_validator_program_library, run_validator
from validator_hashes import program_hashes_hex
from validator_output import Move, MoveCode, MoveOrSlash, Slash
import subprocess

"""
test_handlers.py:

Test off-chain chialisp.
"""

# See also calpoker_generate.clinc
calpoker_factory = load_clvm_hex(
    calpoker_clsp_dir / "calpoker_include_calpoker_factory.hex"
)

# (i_am_initiator my_contribution their_contribution params)

I_AM_INITIATOR = 1  # I am "Alice"
calpoker_factory_alice = calpoker_factory.run([I_AM_INITIATOR, 100, 100, None])
calpoker_handler_alice_data = Program.to(calpoker_factory_alice).as_python()
our_info = calpoker_handler_alice_data[0]
calpoker_factory_bob = calpoker_factory.run([not I_AM_INITIATOR, 100, 100, None])
calpoker_handler_bob_data = Program.to(calpoker_factory_bob).as_python()
bob_info = calpoker_handler_bob_data[0]

# handlers = None
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
    10: "initial_mover_share",
}

# our_data = [x for i,x in enumerate(our_info) if i in [2,3,4,6,7]]
our_data = {name: our_info[index] for index, name in dataf.items()}
bob_data = {name: bob_info[index] for index, name in dataf.items()}

def print_dict(d):
    for k, v in d.items():
        if k not in ["handler_program", "initial_validation_program"]:
            print(f"    {k, v}")


print_dict(our_data)
print_dict(bob_data)

# run alice's handler -> move
# run alice's validator -> readable
# bob moves ->
# handlers only consume an "our move". They may return an advisory SLASH
# handler produces a list of "evidences"
# Validators now produce all game state
# handcalc is called off-chain. It is a heavy operation. We then pass that info on

# handler_args = (new_move, amount, state, last_mover_share, entropy)
# Program.to(our_data["handler_program"]).run()

@dataclass
class HandlerMove:
    input_move_to_our_turn: Program
    entropy: bytes
    blockchain_move_bytes: bytes #output_bytes_from_our_turn
    mover_share: int
    their_turn_report: Program
    test_type: TestType
    expected_message_result: Program

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
    message_parser: Program

    def __init__(
            self,
            handler_name,
            move_bytes,
            validator_for_my_move,
            validator_for_my_move_hash,
            validator_for_their_next_move,
            validator_for_their_move_hash,
            max_move_size,
            new_mover_share,
            their_turn_handler = None,
            message_parser = None
    ):
        self.handler_name = handler_name
        self.move_bytes = move_bytes
        self.validator_for_my_move = validator_for_my_move
        self.validator_for_my_move_hash = validator_for_my_move_hash
        self.validator_for_their_next_move = validator_for_their_next_move
        self.validator_for_their_move_hash = validator_for_their_move_hash
        self.max_move_size = max_move_size
        self.new_mover_share = new_mover_share
        self.their_turn_handler = their_turn_handler
        self.message_parser = message_parser

def call_my_turn_handler(handler: Program, local_move, amount, state, split, entropy):
    "Mover handler"
    print(f"Running handler {handler.get_tree_hash()}")
    raw_args = Program.to([local_move, amount, state, split, entropy])
    print(f"raw args {raw_args}")
    ret = handler.run(raw_args)
    # x = BaseException(ret)
    # return MyTurnHandlerResult(*ret.as_python())
    return MyTurnHandlerResult(*(list(ret.as_python())))


@dataclass
class TheirTurnHandlerArgs:
    amount: int
    pre_state: Program
    state: Program
    move: bytes
    validation_program_hash: bytes32
    mover_share: int

    def as_clvm(self):
        return Program.to(
            [
                self.amount,
                self.pre_state,
                self.state,
                self.move,
                self.validation_program_hash,
                self.mover_share,
            ]
        )


@dataclass
class TheirTurnHandlerResult:
    readable_move: Program
    evidence_list: Program
    my_turn_handler: Program
    message: bytes

    def __init__(self, readable_move, evidence_list, my_turn_handler=None, message=None):
        self.readable_move = readable_move
        self.evidence_list = evidence_list
        self.my_turn_handler = my_turn_handler
        self.message = message

def call_their_turn_handler(handler, args: TheirTurnHandlerArgs, step=None):
    "Waiter handler"
    ret = handler.run(args.as_clvm())
    ret_list = list(ret.as_python())
    if len(ret_list) < 2:
        raise ValueError(f"bad handler result: {ret_list}")
    offset = 0
    if isinstance(ret_list[0], int) and ret_list[0] == MoveCode.MAKE_MOVE.value:
        offset = 1
    if len(ret_list) == offset + 2:
        return TheirTurnHandlerResult(ret_list[offset], ret_list[offset + 1])
    if len(ret_list) == offset + 3:
        return TheirTurnHandlerResult(
            ret_list[offset],
            ret_list[offset + 1],
            ret_list[offset + 2],
        )
    return TheirTurnHandlerResult(
        ret_list[offset],
        ret_list[offset + 1],
        ret_list[offset + 2],
        ret_list[offset + 3],
    )


# my turn: alice a,c,e # we have the current game state locally in "my_turn" handlers
# (local_move amount state split entropy)

# their turn: bob a,c,e == (alice b,d)
# (amount pre_state (@ state (bob_discards alice_selects alice_cards bob_cards alice_hand_value)) move validation_program_hash split)

# a.clsp will be run by both Alice & Bob: this implies Bob ha a special case during his first move

entropy = sha256(b"1").digest()
# ret =  MyTurnHandlerResult(*call_my_turn_handler(first_handler, 0, 200, 0, entropy).as_python())
# print(ret)


def print_step():
    pass


def refactor_me(test_inputs: Dict):
    pass


class TestType(Enum):
    NORMAL = 0
    MUTATE_D_OUTPUT = 1
    CHECK_FOR_ALICE_TRIES_TO_CHEAT = 2

def get_happy_path(test_inputs: Dict, do_evil: bool) -> TestCaseSequence[HandlerMove]:
    """Test move script"""
    seed = GameSeed(test_inputs["seed"])
    preimage = seed.alice_seed
    alice_image = sha256(preimage).digest()
    alice_discards_salt = seed.seed[:16]
    first_move = sha256(seed.alice_seed).digest()
    alice_discards_byte = bitfield_to_byte(test_inputs["alice_discards"])
    good_c_move = (
        seed.alice_seed + sha256(alice_discards_salt + alice_discards_byte).digest()
    )
    bob_discards_byte = bitfield_to_byte(test_inputs["bob_discards"])
    alice_good_selections = bitfield_to_byte(test_inputs["alice_good_selections"])
    # alice_loss_selections = bitfield_to_byte(test_inputs['alice_loss_selections'])
    bob_good_selections = bitfield_to_byte(test_inputs["bob_good_selections"])
    e_move = alice_discards_salt + alice_discards_byte + alice_good_selections

    # All 8 cards initially shown to each player (pre discards and picks)
    alice_all_cards = [
        Card(rank=2, suit=2),
        Card(rank=5, suit=3),
        Card(rank=8, suit=2),
        Card(rank=11, suit=3),
        Card(rank=14, suit=1),
        Card(rank=14, suit=2),
        Card(rank=14, suit=3),
        Card(rank=14, suit=4),
    ]
    bob_all_cards = [
        Card(rank=3, suit=3),
        Card(rank=4, suit=1),
        Card(rank=5, suit=4),
        Card(rank=8, suit=1),
        Card(rank=8, suit=3),
        Card(rank=8, suit=4),
        Card(rank=12, suit=2),
        Card(rank=12, suit=3),
    ]

    alice_hand_value = test_inputs["alice_hand_rating"]
    bob_hand_value = test_inputs["bob_hand_rating"]

    alice_all_cards = [card.as_list() for card in alice_all_cards]
    bob_all_cards = [card.as_list() for card in bob_all_cards]
    d_results = [
        bob_discards_byte,
        alice_good_selections,
        bob_good_selections,
        alice_hand_value,
        bob_hand_value,
        0, # Win result tie
    ]
    e_results = [
        alice_discards_byte,
        alice_good_selections,
        bob_good_selections,
        alice_hand_value,
        bob_hand_value,
        0, # Win result tie
    ]
    alice_initial_handler = None  # my_turn_handler
    bob_initial_handler = None  # their_turn_handler

    # Note: possible todo: display the initial_state in a compatible format

    entropy_data = [GameSeed(seed + test_inputs["seed"]) for seed in range(5)]
    happy_path = [
        # our_readable, entropy, move, mover_share, their_readable
        HandlerMove(None, entropy_data[0].alice_seed, first_move, 0, None, TestType.NORMAL, Program.to(0)),
        HandlerMove(
            None,
            entropy_data[0].bob_seed,
            seed.bob_seed,
            0,
            [alice_all_cards, bob_all_cards],
            TestType.NORMAL,
            # Allow bob to choose cards early before Alice
            # Otherwise, Alice could choose her cards before bob could start choosing
            Program.fromhex("ffffff02ff0280ffff05ff0380ffff08ff0280ffff0bff0380ffff0eff0180ffff0eff0280ffff0eff0380ffff0eff048080ffffff03ff0380ffff04ff0180ffff05ff0480ffff08ff0180ffff08ff0380ffff08ff0480ffff0cff0280ffff0cff03808080")
            # Program.to(0),
        ),
        HandlerMove(
            alice_discards_byte,
            entropy_data[0].seed,
            good_c_move,
            0,
            [alice_all_cards, bob_all_cards],
            TestType.NORMAL,
            Program.to(0),
        ),
        HandlerMove(
            bob_discards_byte,
            entropy_data[0].bob_seed,
            bob_discards_byte,
            0,
            d_results,  # d_results is from alice's their_turn handler
            # in the `do_evil` case, we will expect a slash from bob, because:
            # TODO: edit comment
            # d case: take alice's d instruction and mutate into
            # pass to bob's e, with 'mover_share' set to 0.
            # pass case: bob tries to slash
            TestType.MUTATE_D_OUTPUT if do_evil else TestType.NORMAL,
            Program.to(0),
        ),
        HandlerMove(
            None,
            entropy_data[0].alice_seed,
            e_move,
            100,
            e_results,
            TestType.CHECK_FOR_ALICE_TRIES_TO_CHEAT if do_evil else TestType.NORMAL,
            Program.to(0),
        ),
    ]
    return TestCaseSequence(happy_path)


def run_game(state, move_list, mover_handler, waiter_handler):
    pass


validator_program_library = create_validator_program_library()


def are_any_slash(validator_results: List[MoveOrSlash]) -> bool:
    return any([result.move_code == MoveCode.SLASH for result in validator_results])


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
        amount,
        last_their_turn_message_parser,
    ):
        self.state = state
        self.amount = amount
        self.last_their_turn_message_parser = last_their_turn_message_parser

        if whose_turn:
            self.my_turn_handler = initial_turn_handler
            self.their_turn_handler = None
        else:
            self.my_turn_handler = None
            self.their_turn_handler = initial_turn_handler

        self.their_turn_validator = initial_their_turn_validator
        self.their_turn_validation_program_hash = their_turn_vp_hash

    def run_my_turn_and_generate_move(self, env, move) -> MyTurnHandlerResult:
        # My Turn
        #local_move, entropy, wire_move, mover_share, their_readable = move

        my_turn_result = call_my_turn_handler(
            Program.to(self.my_turn_handler),
            move.input_move_to_our_turn,
            self.amount,
            self.state.state,
            self.state.mover_share,
            move.entropy,
        )

        if move.test_type == TestType.MUTATE_D_OUTPUT:
            print("hit test_type == TestType.MUTATE_D_OUTPUT")
            assert my_turn_result.new_mover_share != 0
            # We will falsely claim
            my_turn_result.new_mover_share = 0
            assert my_turn_result.new_mover_share == 0

        print(f"expected move bytes {move.blockchain_move_bytes} have {my_turn_result.move_bytes}")
        assert my_turn_result.move_bytes == move.blockchain_move_bytes
        print(f"expected mover_share {move.mover_share} have {my_turn_result.new_mover_share}")
        assert Program.to(my_turn_result.new_mover_share).as_python() == Program.to(move.mover_share).as_python()

        self.last_their_turn_message_parser = Program.to(my_turn_result.message_parser)
        self.their_turn_validator = my_turn_result.validator_for_their_next_move
        self.their_turn_validation_program_hash = (
            my_turn_result.validator_for_their_move_hash
        )

        validator_result = run_validator(
            env,
            (move.blockchain_move_bytes, move.mover_share, None, None, False),
            Move(
                MoveCode.MAKE_MOVE,
                my_turn_result.validator_for_their_move_hash,
                self.state.state,
                my_turn_result.max_move_size,
                None,
            ),
            Program.to(my_turn_result.validator_for_my_move),
            None,
        )

        assert (
            validator_result.move_code == MoveCode.MAKE_MOVE
        ), f"Expected to make move, but got {validator_result.move_code}"

        self.state = GameRuntimeInfo(
            validator_result.state,
            my_turn_result.move_bytes,
            my_turn_result.max_move_size,
            my_turn_result.new_mover_share,
        )

        self.their_turn_handler = my_turn_result.their_turn_handler
        return my_turn_result

    def get_state(self):
        return self.state.state

    def handle_message(self, message_from_opponent: bytes, expected_readable, amount):
        if message_from_opponent != b'':
            # Note the use of self.get_state
            decoded_readable_message = self.last_their_turn_message_parser.run([message_from_opponent, self.get_state(), amount])
            dbg_assert_eq(expected_readable, decoded_readable_message)

    def run_their_turn(
            self, env, move_bytes, mover_share, expected_readable_move, test_type
    ) -> TheirTurnHandlerResult:

        if test_type == TestType.CHECK_FOR_ALICE_TRIES_TO_CHEAT:
            mover_share = 0

        validator_result = run_validator(
            env,
            (move_bytes, mover_share, None, None, False),
            Move(
                MoveCode.MAKE_MOVE,
                self.their_turn_validation_program_hash,
                self.state.state,
                self.state.max_move_size,
                None,
            ),
            Program.to(self.their_turn_validator),
            None,
        )

        previous_state = self.state.state
        self.state = GameRuntimeInfo(
            validator_result.state,
            move_bytes,
            self.state.max_move_size,
            mover_share,
        )

        their_turn_result = call_their_turn_handler(
            Program.to(self.their_turn_handler),
            TheirTurnHandlerArgs(
                self.amount,
                previous_state,
                self.state.state,
                move_bytes,
                self.their_turn_validation_program_hash,
                mover_share,
            )
        )

        # their_turn_result
        # if test_type == TestType.CHECK_FOR_ALICE_TRIES_TO_CHEAT and their_turn_result.evidence_list != None:

        expected_validator_result = Program.to(MoveCode.MAKE_MOVE.value).as_python()
        if test_type == TestType.CHECK_FOR_ALICE_TRIES_TO_CHEAT:
            expected_validator_result = Program.to(MoveCode.SLASH.value).as_python()

        validator_results = []
        # if e.clsp returns "evidence", we will check
        for e in their_turn_result.evidence_list:
            validator_result = run_validator(
                env,
                (move_bytes, mover_share, e, None, False),
                Move(
                    MoveCode.MAKE_MOVE,
                    self.their_turn_validation_program_hash,
                    previous_state,
                    self.state.max_move_size,
                    None,
                ),
                Program.to(self.their_turn_validator),
                None,
            )
            validator_results.append(validator_result)
            dbg_assert_eq(MoveCode(int.from_bytes(expected_validator_result, byteorder="big")), validator_result.move_code)

        have_normalized_move = Program.to(their_turn_result.readable_move).as_python()
        expected_normalized_move = Program.to(expected_readable_move).as_python()
        if test_type == TestType.CHECK_FOR_ALICE_TRIES_TO_CHEAT:
            # We expect a slash
            if are_any_slash(validator_results):
                return their_turn_result
        else:
            assert have_normalized_move == expected_normalized_move, f"\n--\nexpected readable move:\n    {expected_normalized_move} \nhave:\n    {have_normalized_move}\n--\n"

        self.my_turn_handler = their_turn_result.my_turn_handler
        return their_turn_result

def test_run_with_moves(seed, state, move_list, amount):
    # step_a = load_clvm_hex(calpoker_clsp_dir / "a.hex")
    # step_a_hash = step_a.get_tree_hash()
    # print("\nstep_a_hash and hash returned:")
    # print(step_a_hash)

    env = GameEnvironment(validator_program_library, amount)
    # move_zero = Move(step_a_hash, None, 32,)
    # move_zero = Move(MoveCode.MAKE_MOVE, next_validator_hash=step_a_hash, state = Program.to(0), next_max_move_size=len(step_a_hash), extra_data=Program.to(0))
    # run_game(s, env, move_zero, 32, move_list)

    # run
    players = [
        Player(
            True,
            our_data["handler_program"],
            our_data["initial_validation_program"],
            our_data["initial_validation_program_hash"],
            state,
            amount,
            Program.to(0),
        ),
        Player(
            False,
            bob_data["handler_program"],
            bob_data["initial_validation_program"],
            bob_data["initial_validation_program_hash"],
            state,
            amount,
            Program.to(0),
        ),
    ]
    player_names = ["alice", "bob"]
    whose_move = 0

    # TODO: Genericise to Seq & Item
    # old_move is the move we got from our test script
    for index, old_move in enumerate(move_list.sequence):
        print(f"\n    ---- STEP: {index} PLAYER {player_names[whose_move]} MY TURN")
        print("MOVE:", old_move)

        # move is a MyTurnHandlerResult which may have been synthesized
        move = players[whose_move].run_my_turn_and_generate_move(
            env,
            old_move
        )

        # print(f"Mutated move: {move}")
        p1_new_computed_state = players[whose_move].get_state()

        whose_move = whose_move ^ 1

        print(f"STEP: {index} PLAYER {player_names[whose_move]} THEIR TURN")

        expected_readable_report = old_move.their_turn_report
        #if move.:
            #have_normalized_move
            #old_move.their_turn_report
            #expected_readable_report.var = val

        their_turn_result = players[whose_move].run_their_turn(
            env,
            move.move_bytes,  # wire move
            move.new_mover_share,  # mover share

            expected_readable_report,  # their readable
            old_move.test_type,
        )

        players[whose_move ^ 1].handle_message(their_turn_result.message, old_move.expected_message_result, amount)

        p2_new_computed_state = players[whose_move].get_state()
        print(f'comparing state {p1_new_computed_state} to {p2_new_computed_state}')
        assert p1_new_computed_state == p2_new_computed_state



def run_test(do_evil: bool):
    seed_case = read_test_case("seed.json")
    test_case = get_happy_path(seed_case, do_evil)
    game_runtime_info = GameRuntimeInfo(our_data["initial_state"], our_data["initial_move"], our_data["initial_max_move_size"], our_data["initial_mover_share"])
    test_run_with_moves(seed_case["seed"], game_runtime_info, test_case, 200)


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

run_test(do_evil=True)
run_test(do_evil=False)
