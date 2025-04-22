from __future__ import annotations

from typing import Any, Optional, Dict, List, Tuple, Union
from pathlib import Path
from hashlib import sha256
from validator_hashes import program_hashes_hex
from clvm_tools_rs import start_clvm_program
from load_clvm_hex import load_clvm_hex
from validator_output import MoveCode, Move, Slash, MoveOrSlash
from clvm_types.sized_bytes import bytes32
from dataclasses import dataclass
from clvm_types.program import Program
import subprocess
import traceback
import json
from seed import GameSeed
from util import dbg_assert_eq

# calpoker_generate.clinc
calpoker_clsp_dir = Path("../clsp/")
calpoker_factory = load_clvm_hex(calpoker_clsp_dir / "calpoker_include_calpoker_factory.hex")



# (i_am_initiator my_contribution their_contribution params)

I_AM_INITIATOR = 1  # I am "Alice"
calpoker_factory_hex = calpoker_factory.run([I_AM_INITIATOR, 100, 100, None])
calpoker_handler_data = Program.to(calpoker_factory_hex).as_python()
game_list = calpoker_handler_data
our_info = game_list[0]

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

def call_my_turn_handler(handler: Program, local_move, amount, split, entropy):
    ret = handler.run([local_move, amount, split, entropy])
    return ret

@dataclass
class TheirTurnHandlerArgs:
    amount: int
    state: Program
    move: bytes
    validation_program_hash: bytes32
    mover_share: int
    def as_clvm(self):
        return Program.to([self.amount, self.state, self.move, self.validation_program_hash, self.mover_share])

def call_their_turn_handler(handler, args: TheirTurnHandlerArgs):
    ret = handler.run(args.as_clvm())
    return ret

# my turn: alice a,c,e # we have the current game state locally in "my_turn" handlers
# (local_move amount split entropy)

# their turn: bob a,c,e == (alice b,d)
# (amount (@ state (bob_discards alice_selects alice_cards bob_cards alice_hand_value)) move validation_program_hash split)

# a.clsp will be run by both Alice & Bob: this implies Bob ha a special case during his first move

@dataclass
class MyTurnHandlerResult:
    move_bytes: bytes
    validator_for_my_move: Program  # validator to run for this move: the move that our handler will produce
    validator_for_my_move_hash: bytes32
    validator_for_their_next_move: Program
    validator_for_their_move_hash: bytes32
    max_move_size: int  # for bob XXX to remove
    new_max_mover_share: int
    their_turn_handler: Program  # If we are Alice, this is the newly parameterized program that will recv Bob's move

entropy = sha256(b"1").digest()
ret =  MyTurnHandlerResult(*call_my_turn_handler(first_handler, 0, 200, 0, entropy).as_python())

print(ret)


def print_step():
    pass
