#![allow(non_snake_case)]

use crate::common::load_clvm::read_hex_puzzle;
use crate::common::types::{chia_dialect, AllocEncoder, Sha256Input};
use crate::utils::proper_list;

use clvm_traits::ToClvm;
use clvmr::allocator::{NodePtr, SExp};
use clvmr::run_program;
use clvmr::serde::node_to_bytes;

const BET_SIZE: i64 = 100;
const AMOUNT: i64 = 2 * BET_SIZE;
const BET_UNIT: i64 = BET_SIZE / 10;

fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    *Sha256Input::Bytes(data).hash().bytes()
}

fn run_clvm(allocator: &mut AllocEncoder, program: NodePtr, args: NodePtr) -> NodePtr {
    run_program(allocator.allocator(), &chia_dialect(), program, args, 0)
        .expect("CLVM run failed")
        .1
}

fn atom_bytes(allocator: &mut AllocEncoder, node: NodePtr) -> Vec<u8> {
    match allocator.allocator().sexp(node) {
        SExp::Atom => allocator.allocator().atom(node).to_vec(),
        _ => panic!("expected atom"),
    }
}

fn int_from_node(allocator: &mut AllocEncoder, node: NodePtr) -> i64 {
    match allocator.allocator().sexp(node) {
        SExp::Atom => {
            let bytes = allocator.allocator().atom(node);
            if bytes.is_empty() {
                return 0;
            }
            let mut val: i64 = if bytes[0] & 0x80 != 0 { -1 } else { 0 };
            for &b in bytes.as_ref() {
                val = (val << 8) | b as i64;
            }
            val
        }
        _ => panic!("expected atom for int"),
    }
}

fn node_to_hex(allocator: &mut AllocEncoder, node: NodePtr) -> String {
    let bytes = node_to_bytes(allocator.allocator(), node).unwrap();
    hex::encode(bytes)
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum MoveCode {
    MakeMove = 0,
    Slash = 2,
}

fn parse_validator_output(allocator: &mut AllocEncoder, result: NodePtr) -> (MoveCode, NodePtr) {
    let items = proper_list(allocator.allocator(), result, true).unwrap();
    if items.is_empty() {
        (MoveCode::Slash, result)
    } else {
        (MoveCode::MakeMove, result)
    }
}

fn run_validator(
    allocator: &mut AllocEncoder,
    validator_hash: NodePtr,
    move_bytes: NodePtr,
    mover_share: i64,
    max_move_size: i64,
    state: NodePtr,
    validator_program: NodePtr,
    evidence: NodePtr,
) -> (MoveCode, NodePtr) {
    let amount_node = AMOUNT.to_clvm(allocator).unwrap();
    let mms_node = max_move_size.to_clvm(allocator).unwrap();
    let ms_node = mover_share.to_clvm(allocator).unwrap();

    let a = allocator.allocator();
    let tail = a.new_pair(NodePtr::NIL, NodePtr::NIL).unwrap();
    let tail = a.new_pair(ms_node, tail).unwrap();
    let tail = a.new_pair(NodePtr::NIL, tail).unwrap();
    let tail = a.new_pair(mms_node, tail).unwrap();
    let tail = a.new_pair(move_bytes, tail).unwrap();
    let tail = a.new_pair(NodePtr::NIL, tail).unwrap();
    let tail = a.new_pair(NodePtr::NIL, tail).unwrap();
    let tail = a.new_pair(amount_node, tail).unwrap();
    let tail = a.new_pair(NodePtr::NIL, tail).unwrap();
    let tail = a.new_pair(NodePtr::NIL, tail).unwrap();
    let curry_args = a.new_pair(NodePtr::NIL, tail).unwrap();

    let tail = a.new_pair(NodePtr::NIL, NodePtr::NIL).unwrap();
    let tail = a.new_pair(evidence, tail).unwrap();
    let tail = a.new_pair(validator_program, tail).unwrap();
    let tail = a.new_pair(state, tail).unwrap();
    let tail = a.new_pair(curry_args, tail).unwrap();
    let args = a.new_pair(validator_hash, tail).unwrap();

    let result = run_clvm(allocator, validator_program, args);
    parse_validator_output(allocator, result)
}

#[allow(dead_code)]
struct MyTurnResult {
    move_bytes_node: NodePtr,
    validator_for_my_move: NodePtr,
    validator_for_my_move_hash: NodePtr,
    validator_for_their_next_move: NodePtr,
    validator_for_their_move_hash: NodePtr,
    max_move_size: i64,
    new_mover_share: i64,
    their_turn_handler: NodePtr,
    message_parser: NodePtr,
}

fn call_my_turn_handler(
    allocator: &mut AllocEncoder,
    handler: NodePtr,
    local_move: NodePtr,
    amount: i64,
    state: NodePtr,
    split: i64,
    entropy: NodePtr,
) -> MyTurnResult {
    let amount_node = amount.to_clvm(allocator).unwrap();
    let split_node = split.to_clvm(allocator).unwrap();
    let a = allocator.allocator();
    let tail = a.new_pair(entropy, NodePtr::NIL).unwrap();
    let tail = a.new_pair(split_node, tail).unwrap();
    let tail = a.new_pair(state, tail).unwrap();
    let tail = a.new_pair(amount_node, tail).unwrap();
    let args = a.new_pair(local_move, tail).unwrap();

    let result = run_clvm(allocator, handler, args);
    let items = proper_list(allocator.allocator(), result, true)
        .expect("my_turn handler should return a list");

    assert!(
        items.len() >= 8,
        "my_turn handler returned {} items, expected >= 8",
        items.len()
    );

    MyTurnResult {
        move_bytes_node: items[1],
        validator_for_my_move: items[2],
        validator_for_my_move_hash: items[3],
        validator_for_their_next_move: items[4],
        validator_for_their_move_hash: items[5],
        max_move_size: int_from_node(allocator, items[6]),
        new_mover_share: int_from_node(allocator, items[7]),
        their_turn_handler: if items.len() > 8 {
            items[8]
        } else {
            NodePtr::NIL
        },
        message_parser: if items.len() > 9 {
            items[9]
        } else {
            NodePtr::NIL
        },
    }
}

#[allow(dead_code)]
struct TheirTurnResult {
    readable_move: NodePtr,
    evidence_list: NodePtr,
    my_turn_handler: NodePtr,
    message: NodePtr,
}

fn call_their_turn_handler(
    allocator: &mut AllocEncoder,
    handler: NodePtr,
    amount: i64,
    pre_state: NodePtr,
    state: NodePtr,
    move_bytes: NodePtr,
    validation_program_hash: NodePtr,
    mover_share: i64,
) -> TheirTurnResult {
    let amount_node = amount.to_clvm(allocator).unwrap();
    let ms_node = mover_share.to_clvm(allocator).unwrap();
    let a = allocator.allocator();
    let tail = a.new_pair(ms_node, NodePtr::NIL).unwrap();
    let tail = a.new_pair(validation_program_hash, tail).unwrap();
    let tail = a.new_pair(move_bytes, tail).unwrap();
    let tail = a.new_pair(state, tail).unwrap();
    let tail = a.new_pair(pre_state, tail).unwrap();
    let args = a.new_pair(amount_node, tail).unwrap();

    let result = run_clvm(allocator, handler, args);

    let items = match proper_list(allocator.allocator(), result, true) {
        Some(items) => items,
        None => {
            let mut items = Vec::new();
            let mut cur = result;
            loop {
                match allocator.allocator().sexp(cur) {
                    SExp::Pair(a, b) => {
                        items.push(a);
                        cur = b;
                    }
                    SExp::Atom => break,
                }
            }
            items
        }
    };

    assert!(
        items.len() >= 2,
        "their_turn handler returned {} items, expected >= 2",
        items.len()
    );

    let first_is_movecode = match allocator.allocator().sexp(items[0]) {
        SExp::Atom => {
            let bytes = allocator.allocator().atom(items[0]);
            !bytes.is_empty() && int_from_node(allocator, items[0]) == 0
        }
        _ => false,
    };
    let offset = if first_is_movecode { 1 } else { 0 };

    TheirTurnResult {
        readable_move: items[offset],
        evidence_list: items[offset + 1],
        my_turn_handler: if items.len() > offset + 2 {
            items[offset + 2]
        } else {
            NodePtr::NIL
        },
        message: if items.len() > offset + 3 {
            items[offset + 3]
        } else {
            NodePtr::NIL
        },
    }
}

#[allow(dead_code)]
struct GameSetup {
    alice_handler: NodePtr,
    alice_validator: NodePtr,
    bob_handler: NodePtr,
    bob_validator: NodePtr,
    initial_validator_hash: NodePtr,
    initial_state: NodePtr,
    initial_move: NodePtr,
    initial_max_move_size: i64,
    initial_mover_share: i64,
}

fn setup_game(allocator: &mut AllocEncoder) -> GameSetup {
    let make_proposal = read_hex_puzzle(
        allocator,
        "clsp/games/spacepoker/spacepoker_include_spacepoker_make_proposal.hex",
    )
    .expect("load make_proposal");
    let parser = read_hex_puzzle(
        allocator,
        "clsp/games/spacepoker/spacepoker_include_spacepoker_parser.hex",
    )
    .expect("load parser");

    let make_proposal_clvm = make_proposal.to_clvm(allocator).unwrap();
    let parser_clvm = parser.to_clvm(allocator).unwrap();

    let bet_args = (BET_SIZE, ()).to_clvm(allocator).unwrap();
    let proposal_result = run_clvm(allocator, make_proposal_clvm, bet_args);

    let proposal_list = proper_list(allocator.allocator(), proposal_result, true).unwrap();
    assert!(
        proposal_list.len() >= 2,
        "make_proposal returned {} elements",
        proposal_list.len()
    );
    let wire_data = proposal_list[0];
    let local_data = proposal_list[1];

    let wire_data_list = proper_list(allocator.allocator(), wire_data, true).unwrap();
    let game_specs_wrapper = proper_list(allocator.allocator(), wire_data_list[2], true).unwrap();
    let game_spec = proper_list(allocator.allocator(), game_specs_wrapper[0], true).unwrap();
    let initial_validator_hash = game_spec[2];
    let initial_move = game_spec[3];
    let initial_max_move_size = int_from_node(allocator, game_spec[4]);
    let initial_state = game_spec[5];
    let initial_mover_share = int_from_node(allocator, game_spec[6]);

    let local_data_list = proper_list(allocator.allocator(), local_data, true).unwrap();
    let hv_list = proper_list(allocator.allocator(), local_data_list[0], true).unwrap();
    assert!(
        hv_list.len() >= 2,
        "handler_validator has {} elements",
        hv_list.len()
    );
    let alice_handler = hv_list[0];
    let alice_validator = hv_list[1];

    let parser_result = run_clvm(allocator, parser_clvm, wire_data);
    let parser_list = proper_list(allocator.allocator(), parser_result, true).unwrap();
    let bob_data_list = proper_list(allocator.allocator(), parser_list[1], true).unwrap();
    let bob_hv_list = proper_list(allocator.allocator(), bob_data_list[0], true).unwrap();
    let bob_validator = bob_hv_list[0];
    let bob_handler = bob_hv_list[1];

    GameSetup {
        alice_handler,
        alice_validator,
        bob_handler,
        bob_validator,
        initial_validator_hash,
        initial_state,
        initial_move,
        initial_max_move_size,
        initial_mover_share,
    }
}

#[derive(Clone, Copy)]
enum TestType {
    Normal,
    MutateMoverShare,
    CheckForSlashEvidence,
}

struct HandlerMove {
    input_move: NodePtr,
    entropy: NodePtr,
    expected_mover_share: Option<i64>,
    test_type: TestType,
}

fn run_handler_game(allocator: &mut AllocEncoder, setup: &GameSetup, moves: &[HandlerMove]) {
    let mut alice_my_turn_handler = setup.alice_handler;
    let mut alice_their_turn_handler: NodePtr = NodePtr::NIL;
    let mut bob_my_turn_handler: NodePtr = NodePtr::NIL;
    let mut bob_their_turn_handler = setup.bob_handler;

    let mut alice_state = setup.initial_state;
    let mut bob_state = setup.initial_state;
    let mut alice_mover_share = setup.initial_mover_share;
    let mut bob_mover_share = setup.initial_mover_share;
    let mut alice_max_move_size = setup.initial_max_move_size;
    let mut bob_max_move_size = setup.initial_max_move_size;

    let mut alice_their_turn_validator = setup.alice_validator;
    let mut bob_their_turn_validator = setup.bob_validator;
    let mut alice_their_turn_vp_hash = setup.initial_validator_hash;
    let mut bob_their_turn_vp_hash = setup.initial_validator_hash;

    let mut whose_move: usize = 0;

    for (step_idx, hm) in moves.iter().enumerate() {
        let is_alice = whose_move == 0;

        let (handler, state, mover_share) = if is_alice {
            (alice_my_turn_handler, alice_state, alice_mover_share)
        } else {
            (bob_my_turn_handler, bob_state, bob_mover_share)
        };

        let mut my_turn = call_my_turn_handler(
            allocator,
            handler,
            hm.input_move,
            AMOUNT,
            state,
            mover_share,
            hm.entropy,
        );

        let original_mover_share = my_turn.new_mover_share;

        if matches!(hm.test_type, TestType::MutateMoverShare) {
            my_turn.new_mover_share = 0;
        }

        if let Some(expected_ms) = hm.expected_mover_share {
            assert_eq!(
                original_mover_share, expected_ms,
                "step {step_idx}: mover_share mismatch (got {}, expected {})",
                original_mover_share, expected_ms
            );
        }

        let (code, validator_result) = run_validator(
            allocator,
            my_turn.validator_for_my_move_hash,
            my_turn.move_bytes_node,
            original_mover_share,
            my_turn.max_move_size,
            state,
            my_turn.validator_for_my_move,
            NodePtr::NIL,
        );
        assert_eq!(
            code,
            MoveCode::MakeMove,
            "step {step_idx}: validator rejected our move (player={})",
            if is_alice { "alice" } else { "bob" }
        );

        let validator_items = proper_list(allocator.allocator(), validator_result, true).unwrap();
        let new_state = validator_items[1];

        if is_alice {
            alice_state = new_state;
            alice_mover_share = my_turn.new_mover_share;
            alice_max_move_size = my_turn.max_move_size;
            alice_their_turn_vp_hash = my_turn.validator_for_their_move_hash;
            alice_their_turn_validator = my_turn.validator_for_their_next_move;
            alice_their_turn_handler = my_turn.their_turn_handler;
        } else {
            bob_state = new_state;
            bob_mover_share = my_turn.new_mover_share;
            bob_max_move_size = my_turn.max_move_size;
            bob_their_turn_vp_hash = my_turn.validator_for_their_move_hash;
            bob_their_turn_validator = my_turn.validator_for_their_next_move;
            bob_their_turn_handler = my_turn.their_turn_handler;
        }

        whose_move ^= 1;
        let is_alice_waiter = whose_move == 0;

        let (waiter_handler, waiter_state, waiter_vp_hash, waiter_max_move_size) =
            if is_alice_waiter {
                (
                    alice_their_turn_handler,
                    alice_state,
                    alice_their_turn_vp_hash,
                    alice_max_move_size,
                )
            } else {
                (
                    bob_their_turn_handler,
                    bob_state,
                    bob_their_turn_vp_hash,
                    bob_max_move_size,
                )
            };

        let effective_mover_share = if matches!(hm.test_type, TestType::CheckForSlashEvidence) {
            0
        } else {
            my_turn.new_mover_share
        };

        let (waiter_code, waiter_validator_result) = run_validator(
            allocator,
            waiter_vp_hash,
            my_turn.move_bytes_node,
            effective_mover_share,
            waiter_max_move_size,
            waiter_state,
            if is_alice_waiter {
                alice_their_turn_validator
            } else {
                bob_their_turn_validator
            },
            NodePtr::NIL,
        );

        if matches!(hm.test_type, TestType::MutateMoverShare) {
            assert_eq!(
                waiter_code,
                MoveCode::Slash,
                "step {step_idx}: expected slash for mutated mover_share"
            );
            return;
        }

        let waiter_validator_items =
            proper_list(allocator.allocator(), waiter_validator_result, true).unwrap();
        let waiter_new_state = waiter_validator_items[1];

        let their_turn = call_their_turn_handler(
            allocator,
            waiter_handler,
            AMOUNT,
            waiter_state,
            waiter_new_state,
            my_turn.move_bytes_node,
            waiter_vp_hash,
            effective_mover_share,
        );

        if matches!(hm.test_type, TestType::CheckForSlashEvidence) {
            let evidence_items = proper_list(allocator.allocator(), their_turn.evidence_list, true);
            if let Some(items) = evidence_items {
                let mut found_slash = false;
                for ev in &items {
                    let (ev_code, _) = run_validator(
                        allocator,
                        waiter_vp_hash,
                        my_turn.move_bytes_node,
                        effective_mover_share,
                        waiter_max_move_size,
                        waiter_state,
                        if is_alice_waiter {
                            alice_their_turn_validator
                        } else {
                            bob_their_turn_validator
                        },
                        *ev,
                    );
                    if ev_code == MoveCode::Slash {
                        found_slash = true;
                    }
                }
                assert!(found_slash, "step {step_idx}: expected slash evidence");
            }
        }

        if is_alice_waiter {
            alice_state = waiter_new_state;
            alice_mover_share = effective_mover_share;
            alice_my_turn_handler = their_turn.my_turn_handler;
        } else {
            bob_state = waiter_new_state;
            bob_mover_share = effective_mover_share;
            bob_my_turn_handler = their_turn.my_turn_handler;
        }

        let alice_hex = node_to_hex(allocator, alice_state);
        let bob_hex = node_to_hex(allocator, bob_state);
        assert_eq!(
            alice_hex, bob_hex,
            "step {step_idx}: alice and bob states diverged"
        );
    }
}

fn make_entropy(allocator: &mut AllocEncoder, seed: &str) -> NodePtr {
    let hash = sha256_bytes(seed.as_bytes());
    allocator.allocator().new_atom(&hash).unwrap()
}

fn test_spacepoker_setup_game() {
    let mut allocator = AllocEncoder::new();
    let setup = setup_game(&mut allocator);
    assert_eq!(setup.initial_max_move_size, 32);
    assert_eq!(setup.initial_mover_share, 0);
    let state_val = int_from_node(&mut allocator, setup.initial_state);
    assert_eq!(state_val, BET_UNIT, "initial state should be bet_unit");
}

fn test_spacepoker_happy_path_all_calls() {
    let mut allocator = AllocEncoder::new();
    let setup = setup_game(&mut allocator);

    let entropy_alice = make_entropy(&mut allocator, "alice_entropy_1027");
    let entropy_bob = make_entropy(&mut allocator, "bob_entropy_1027");

    let bet_unit = BET_UNIT;
    let half_pot = bet_unit;
    let mover_share_betting = AMOUNT / 2 - half_pot;
    let zero_raise = 0i64.to_clvm(&mut allocator).unwrap();

    let mut moves = vec![
        // 0: Alice commitA (automatic)
        HandlerMove {
            input_move: NodePtr::NIL,
            entropy: entropy_alice,
            expected_mover_share: Some(AMOUNT / 2),
            test_type: TestType::Normal,
        },
        // 1: Bob commitB (automatic)
        HandlerMove {
            input_move: NodePtr::NIL,
            entropy: entropy_bob,
            expected_mover_share: Some(AMOUNT / 2 - bet_unit),
            test_type: TestType::Normal,
        },
    ];

    for _street in 0..4 {
        moves.push(HandlerMove {
            input_move: zero_raise,
            entropy: entropy_alice,
            expected_mover_share: Some(mover_share_betting),
            test_type: TestType::Normal,
        });
        moves.push(HandlerMove {
            input_move: NodePtr::NIL,
            entropy: entropy_bob,
            expected_mover_share: Some(mover_share_betting),
            test_type: TestType::Normal,
        });
    }

    // End: Alice reveals preimage, auto-selects best hand
    moves.push(HandlerMove {
        input_move: NodePtr::NIL,
        entropy: entropy_alice,
        expected_mover_share: None,
        test_type: TestType::Normal,
    });

    run_handler_game(&mut allocator, &setup, &moves);
}

fn run_hand_eval(allocator: &mut AllocEncoder, cards: &[i64], boost: i64) -> Vec<i64> {
    let program = read_hex_puzzle(
        allocator,
        "clsp/test/test_space_hand_eval_space_hand_eval.hex",
    )
    .expect("load space_hand_eval");
    let program_clvm = program.to_clvm(allocator).unwrap();
    let cards_node = cards.to_clvm(allocator).unwrap();
    let boost_node = boost.to_clvm(allocator).unwrap();
    let a = allocator.allocator();
    let args = a.new_pair(boost_node, NodePtr::NIL).unwrap();
    let args = a.new_pair(cards_node, args).unwrap();
    let result = run_clvm(allocator, program_clvm, args);
    let items = proper_list(allocator.allocator(), result, true).unwrap();
    items.iter().map(|n| int_from_node(allocator, *n)).collect()
}

fn test_hand_eval_high_card() {
    let mut a = AllocEncoder::new();
    let result = run_hand_eval(&mut a, &[14, 10, 7, 5, 3], 0);
    assert_eq!(result[0], 1, "high card should have type prefix 1");
    assert!(
        result.len() >= 6,
        "high card should have 5 count elements + boost + ranks"
    );
}

fn test_hand_eval_pair() {
    let mut a = AllocEncoder::new();
    let result = run_hand_eval(&mut a, &[10, 10, 7, 5, 3], 0);
    assert_eq!(result[0], 2, "pair should have leading count 2");
}

fn test_hand_eval_two_pair() {
    let mut a = AllocEncoder::new();
    let result = run_hand_eval(&mut a, &[10, 10, 7, 7, 3], 0);
    assert_eq!(result[0], 2, "two pair first count = 2");
    assert_eq!(result[1], 2, "two pair second count = 2");
}

fn test_hand_eval_set() {
    let mut a = AllocEncoder::new();
    let result = run_hand_eval(&mut a, &[10, 10, 10, 7, 3], 0);
    assert_eq!(result[0], 3, "set first count = 3");
    assert_eq!(result[1], 1, "set second count = 1");
    assert_eq!(result[2], 1, "set third count = 1");
}

fn test_hand_eval_straight() {
    let mut a = AllocEncoder::new();
    let result = run_hand_eval(&mut a, &[10, 9, 8, 7, 6], 0);
    assert_eq!(result[0], 3, "straight type prefix = 3");
    assert_eq!(result[1], 3, "straight second = 3");
}

fn test_hand_eval_full_house() {
    let mut a = AllocEncoder::new();
    let result = run_hand_eval(&mut a, &[10, 10, 10, 7, 7], 0);
    assert_eq!(result[0], 3, "full house first count = 3");
    assert_eq!(result[1], 2, "full house second count = 2");
}

fn test_hand_eval_four_of_a_kind() {
    let mut a = AllocEncoder::new();
    let result = run_hand_eval(&mut a, &[10, 10, 10, 10, 7], 0);
    assert_eq!(result[0], 4, "four of a kind first count = 4");
}

fn test_hand_eval_five_of_a_kind() {
    let mut a = AllocEncoder::new();
    let result = run_hand_eval(&mut a, &[10, 10, 10, 10, 10], 0);
    assert_eq!(result[0], 5, "five of a kind first count = 5");
}

fn test_straight_beats_full_house() {
    let mut a = AllocEncoder::new();
    let straight = run_hand_eval(&mut a, &[10, 9, 8, 7, 6], 0);
    let full_house = run_hand_eval(&mut a, &[14, 14, 14, 13, 13], 0);
    let s_node = straight.to_clvm(&mut a).unwrap();
    let f_node = full_house.to_clvm(&mut a).unwrap();
    // Load deep_compare — we can just compare the vectors lexicographically
    assert!(
        straight > full_house,
        "straight {:?} should beat full house {:?} in suitless poker",
        straight,
        full_house
    );
}

fn test_boosted_set_does_not_beat_unboosted_full_house() {
    let mut a = AllocEncoder::new();
    let boosted_set = run_hand_eval(&mut a, &[10, 10, 10, 7, 3], 1);
    let unboosted_fh = run_hand_eval(&mut a, &[8, 8, 8, 5, 5], 0);
    assert!(
        unboosted_fh > boosted_set,
        "unboosted full house {:?} should beat boosted set {:?}",
        unboosted_fh,
        boosted_set
    );
}

fn test_boost_wins_within_same_hand_type() {
    let mut a = AllocEncoder::new();
    let boosted_pair = run_hand_eval(&mut a, &[10, 10, 7, 5, 3], 1);
    let unboosted_pair = run_hand_eval(&mut a, &[10, 10, 7, 5, 3], 0);
    assert!(
        boosted_pair > unboosted_pair,
        "boosted pair {:?} should beat same unboosted pair {:?}",
        boosted_pair,
        unboosted_pair
    );
}

fn test_evil_path_wrong_mover_share() {
    let mut allocator = AllocEncoder::new();
    let setup = setup_game(&mut allocator);

    let entropy_alice = make_entropy(&mut allocator, "alice_entropy_1027");
    let entropy_bob = make_entropy(&mut allocator, "bob_entropy_1027");

    let bet_unit = BET_UNIT;
    let half_pot = bet_unit;
    let mover_share_betting = AMOUNT / 2 - half_pot;
    let zero_raise = 0i64.to_clvm(&mut allocator).unwrap();

    let mut moves = vec![
        HandlerMove {
            input_move: NodePtr::NIL,
            entropy: entropy_alice,
            expected_mover_share: Some(AMOUNT / 2),
            test_type: TestType::Normal,
        },
        HandlerMove {
            input_move: NodePtr::NIL,
            entropy: entropy_bob,
            expected_mover_share: Some(AMOUNT / 2 - bet_unit),
            test_type: TestType::Normal,
        },
    ];

    // 4 streets — mutate mover_share on street 2 begin_round,
    // check for slash evidence on the following mid_round
    for street in 0..4 {
        let (test_type_begin, expect_begin) = if street == 2 {
            (TestType::MutateMoverShare, None)
        } else {
            (TestType::Normal, Some(mover_share_betting))
        };
        let (test_type_mid, expect_mid) = if street == 2 {
            (TestType::CheckForSlashEvidence, None)
        } else {
            (TestType::Normal, Some(mover_share_betting))
        };
        moves.push(HandlerMove {
            input_move: zero_raise,
            entropy: entropy_alice,
            expected_mover_share: expect_begin,
            test_type: test_type_begin,
        });
        moves.push(HandlerMove {
            input_move: NodePtr::NIL,
            entropy: entropy_bob,
            expected_mover_share: expect_mid,
            test_type: test_type_mid,
        });
    }

    moves.push(HandlerMove {
        input_move: NodePtr::NIL,
        entropy: entropy_alice,
        expected_mover_share: None,
        test_type: TestType::Normal,
    });

    run_handler_game(&mut allocator, &setup, &moves);
}

fn run_end_validator_with_evidence(
    allocator: &mut AllocEncoder,
    move_bytes: &[u8],
    mover_share: i64,
    state: NodePtr,
    evidence: &[u8],
) -> MoveCode {
    use crate::common::types::Sha256tree;
    let end_puzzle = read_hex_puzzle(allocator, "clsp/games/spacepoker/onchain/end.hex")
        .expect("load end validator");
    let end_hash_bytes = *end_puzzle.sha256tree(allocator).hash().bytes();
    let end_hash_node = allocator.allocator().new_atom(&end_hash_bytes).unwrap();
    let move_node = allocator.allocator().new_atom(move_bytes).unwrap();
    let evidence_node = allocator.allocator().new_atom(evidence).unwrap();
    let program_node = end_puzzle.to_clvm(allocator).unwrap();
    let (code, _) = run_validator(
        allocator,
        end_hash_node,
        move_node,
        mover_share,
        33,
        state,
        program_node,
        evidence_node,
    );
    code
}

fn test_generous_mover_share_allowed() {
    let mut allocator = AllocEncoder::new();

    let alice_pre = sha256_bytes(b"alice_entropy_1027");
    let bob_pre = sha256_bytes(b"bob_entropy_1027");
    let alice_image_1 = sha256_bytes(&alice_pre);
    let half_pot: i64 = BET_UNIT;

    let state = {
        let hp = half_pot.to_clvm(&mut allocator).unwrap();
        let mi = allocator.allocator().new_atom(&alice_image_1).unwrap();
        let wp = allocator.allocator().new_atom(&bob_pre).unwrap();
        let a = allocator.allocator();
        let tail = a.new_pair(wp, NodePtr::NIL).unwrap();
        let tail = a.new_pair(mi, tail).unwrap();
        a.new_pair(hp, tail).unwrap()
    };

    let mut move_bytes = alice_pre.to_vec();
    move_bytes.push(0x1F); // select first 5 cards

    let evidence = [0x1F_u8]; // waiter also selects first 5

    // First: verify with correct mover_share (whatever it is) the validator accepts
    let correct_code =
        run_end_validator_with_evidence(&mut allocator, &move_bytes, AMOUNT / 2, state, &evidence);
    // This should not slash (generous or correct)
    assert_eq!(
        correct_code,
        MoveCode::MakeMove,
        "correct/generous mover_share should be accepted"
    );

    // Now try with mover_share = 0 (maximally generous to opponent)
    let generous_code =
        run_end_validator_with_evidence(&mut allocator, &move_bytes, 0, state, &evidence);
    assert_eq!(
        generous_code,
        MoveCode::MakeMove,
        "generous mover_share=0 should be accepted (mover gives everything away)"
    );
}

fn test_greedy_mover_share_slashed() {
    let mut allocator = AllocEncoder::new();

    let alice_pre = sha256_bytes(b"alice_entropy_1027");
    let bob_pre = sha256_bytes(b"bob_entropy_1027");
    let alice_image_1 = sha256_bytes(&alice_pre);
    let half_pot: i64 = BET_UNIT;

    let state = {
        let hp = half_pot.to_clvm(&mut allocator).unwrap();
        let mi = allocator.allocator().new_atom(&alice_image_1).unwrap();
        let wp = allocator.allocator().new_atom(&bob_pre).unwrap();
        let a = allocator.allocator();
        let tail = a.new_pair(wp, NodePtr::NIL).unwrap();
        let tail = a.new_pair(mi, tail).unwrap();
        a.new_pair(hp, tail).unwrap()
    };

    let mut move_bytes = alice_pre.to_vec();
    move_bytes.push(0x1F);

    let evidence = [0x1F_u8];

    // Claim the entire amount — this is greedy (mover takes everything)
    let greedy_code =
        run_end_validator_with_evidence(&mut allocator, &move_bytes, AMOUNT, state, &evidence);
    assert_eq!(
        greedy_code,
        MoveCode::Slash,
        "greedy mover_share=AMOUNT should be slashed"
    );
}

pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
    vec![
        ("test_spacepoker_setup_game", &test_spacepoker_setup_game),
        (
            "test_spacepoker_happy_path_all_calls",
            &test_spacepoker_happy_path_all_calls,
        ),
        ("test_hand_eval_high_card", &test_hand_eval_high_card),
        ("test_hand_eval_pair", &test_hand_eval_pair),
        ("test_hand_eval_two_pair", &test_hand_eval_two_pair),
        ("test_hand_eval_set", &test_hand_eval_set),
        ("test_hand_eval_straight", &test_hand_eval_straight),
        ("test_hand_eval_full_house", &test_hand_eval_full_house),
        (
            "test_hand_eval_four_of_a_kind",
            &test_hand_eval_four_of_a_kind,
        ),
        (
            "test_hand_eval_five_of_a_kind",
            &test_hand_eval_five_of_a_kind,
        ),
        (
            "test_straight_beats_full_house",
            &test_straight_beats_full_house,
        ),
        (
            "test_boosted_set_does_not_beat_unboosted_full_house",
            &test_boosted_set_does_not_beat_unboosted_full_house,
        ),
        (
            "test_boost_wins_within_same_hand_type",
            &test_boost_wins_within_same_hand_type,
        ),
        (
            "test_evil_path_wrong_mover_share",
            &test_evil_path_wrong_mover_share,
        ),
        (
            "test_generous_mover_share_allowed",
            &test_generous_mover_share_allowed,
        ),
        (
            "test_greedy_mover_share_slashed",
            &test_greedy_mover_share_slashed,
        ),
    ]
}
