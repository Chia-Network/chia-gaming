import os
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path

from clvm_types.program import Program
from load_clvm_hex import load_clvm_hex
from util import dbg_assert_eq

calpoker_clsp_dir = Path("../clsp/onchain/calpoker/")
cwd = Path(os.path.dirname(__file__))
test_handcalc_micro = load_clvm_hex(cwd / "../clsp/test/test_handcalc_micro.hex")

functions = "pull_out_cards"

# @dataclass
# class TestItem:
#     args: Any
#     expected_output: Any

make_cards_tests = []


def test_make_cards():
    randomness = sha256("a")
    test_handcalc_micro.run(["make_cards", randomness])


pull_out_cards_tests = [
    {
        "selections": 0b00011111,
        "cards": [bytes([x]) for x in range(8)],
        "expected": [
            [b"\x02", b"\x01"],
            [b"\x02", b"\x02"],
            [b"\x02", b"\x03"],
            [b"\x02", b"\x04"],
            [b"\x03", b"\x01"],
        ],
        "msg": "pull_out_cards should return last 5 elements of 'cards'",
    }
]


def test_pull_out_cards(args):
    """TODO: Test popcount(arg[0]) != 5"""
    selections = args["selections"]
    cards = args["cards"]
    expected = args["expected"]
    msg = args["msg"]
    print(selections, cards)
    try:
        ret = test_handcalc_micro.run(["pull_out_cards", selections, cards])
    except Exception as e:
        print(e)
        return None
    dbg_assert_eq(expected, ret.as_python(), f"test_pull_out_cards({args}): {msg}")


split_cards_tests = [
    {
        "selections": 0b00001111,
        "cards": [bytes([x]) for x in range(8)],
        "expected": [
            [b"\x07", b"\x06", b"\x05", b"\x04"],
            [b"\x03", b"\x02", b"\x01", b"\x00"],
        ],
        "msg": "split_cards xxx",
    }
]


def test_split_cards(args):
    """ "TODO: Test popcount(selections) == 4"""
    ret = test_handcalc_micro.run(["split_cards", args["selections"], args["cards"]])
    dbg_assert_eq(
        args["expected"], ret.as_python(), f"test_split_cards({args}): {args['msg']}"
    )


# args: alice_cards alice_picks bob_cards bob_picks
get_final_cards_in_canonical_order_tests = [
    {
        "expected": [],
        "alice_cards": [bytes([x]) for x in range(8)],  # len == 8
        "alice_picks": 0b00001111,
        "bob_cards": [bytes([x + 16]) for x in range(8)],  # len == 8
        "bob_picks": 0b11110000,
        "msg": "get_final_cards_in_canonical_order_tests xxx",
    }
]


def test_get_final_cards_in_canonical_order(args):
    ret = test_handcalc_micro.run(
        [
            "get_final_cards_in_canonical_order",
            args["alice_cards"],
            args["alice_picks"],
            args["bob_cards"],
            args["bob_picks"],
        ]
    )
    dbg_assert_eq(
        args["expected"],
        ret.as_python(),
        f"test_get_final_cards_in_canonical_order({args}): {args['msg']}",
    )


# test_pull_out_cards(pull_out_cards_tests[0])
# test_split_cards(split_cards_tests[0])

test_get_final_cards_in_canonical_order(get_final_cards_in_canonical_order_tests[0])
