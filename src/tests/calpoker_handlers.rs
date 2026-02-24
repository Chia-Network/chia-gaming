use std::collections::HashMap;

use crate::common::load_clvm::read_hex_puzzle;
use crate::common::types::{chia_dialect, AllocEncoder, Puzzle, Sha256Input, Sha256tree};
use crate::utils::proper_list;

use clvm_traits::ToClvm;
use clvmr::allocator::{NodePtr, SExp};
use clvmr::run_program;
use clvmr::serde::node_to_bytes;

const BET_SIZE: i64 = 100;
const AMOUNT: i64 = 2 * BET_SIZE;

fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    *Sha256Input::Bytes(data).hash().bytes()
}

fn sha256_concat(parts: &[&[u8]]) -> [u8; 32] {
    let inputs: Vec<Sha256Input> = parts.iter().map(|b| Sha256Input::Bytes(b)).collect();
    *Sha256Input::Array(inputs).hash().bytes()
}

fn bitfield_to_byte(indices: &[u8]) -> Vec<u8> {
    let mut v: u8 = 0;
    for &bit in indices {
        v |= 1 << bit;
    }
    vec![v]
}

struct GameSeed {
    alice_seed: Vec<u8>,
    bob_seed: Vec<u8>,
    seed: Vec<u8>,
}

impl GameSeed {
    fn new(int_seed: u64) -> Self {
        let alice_seed = sha256_bytes(format!("alice{int_seed}").as_bytes())[..16].to_vec();
        let bob_seed = sha256_bytes(format!("bob{int_seed}").as_bytes())[..16].to_vec();
        let amount_byte: u8 = 200;
        let seed = sha256_concat(&[&alice_seed, &bob_seed, &[amount_byte]])[..].to_vec();
        GameSeed {
            alice_seed,
            bob_seed,
            seed,
        }
    }
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

struct ValidatorInfo {
    puzzle: Puzzle,
}

struct ValidatorLibrary {
    by_hash: HashMap<Vec<u8>, ValidatorInfo>,
}

fn load_validator_library(allocator: &mut AllocEncoder) -> ValidatorLibrary {
    let mut by_hash = HashMap::new();
    for name in &["a", "b", "c", "d", "e"] {
        let path = format!("clsp/games/calpoker/onchain/{name}.hex");
        let puzzle = read_hex_puzzle(allocator, &path).unwrap();
        let ph = puzzle.sha256tree(allocator);
        by_hash.insert(ph.bytes().to_vec(), ValidatorInfo { puzzle });
    }
    ValidatorLibrary { by_hash }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum MoveCode {
    MakeMove = 0,
    Slash = 2,
}

fn parse_validator_output(allocator: &mut AllocEncoder, result: NodePtr) -> (MoveCode, NodePtr) {
    let items = proper_list(allocator.allocator(), result, true).unwrap();
    let code = int_from_node(allocator, items[0]);
    match code {
        0 => (MoveCode::MakeMove, result),
        2 => (MoveCode::Slash, result),
        _ => panic!("unexpected move code: {code}"),
    }
}

fn run_validator(
    allocator: &mut AllocEncoder,
    lib: &ValidatorLibrary,
    validator_hash: NodePtr,
    move_bytes: NodePtr,
    mover_share: i64,
    max_move_size: i64,
    state: NodePtr,
    validator_program_node: NodePtr,
    evidence: NodePtr,
) -> (MoveCode, NodePtr) {
    let hash_bytes = atom_bytes(allocator, validator_hash);
    let info = lib
        .by_hash
        .get(&hash_bytes)
        .unwrap_or_else(|| panic!("unknown validator: {}", hex::encode(&hash_bytes)));
    let program_clvm = info.puzzle.to_clvm(allocator).unwrap();

    let amount_node = AMOUNT.to_clvm(allocator).unwrap();
    let mms_node = max_move_size.to_clvm(allocator).unwrap();
    let ms_node = mover_share.to_clvm(allocator).unwrap();

    let a = allocator.allocator();
    // curry_args: (nil nil nil amount nil nil move max_move_size nil mover_share nil)
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

    // args: (vh curry_args state validator_program nil nil evidence)
    let tail = a.new_pair(evidence, NodePtr::NIL).unwrap();
    let tail = a.new_pair(NodePtr::NIL, tail).unwrap();
    let tail = a.new_pair(NodePtr::NIL, tail).unwrap();
    let tail = a.new_pair(validator_program_node, tail).unwrap();
    let tail = a.new_pair(state, tail).unwrap();
    let tail = a.new_pair(curry_args, tail).unwrap();
    let args = a.new_pair(validator_hash, tail).unwrap();

    let result = run_clvm(allocator, program_clvm, args);
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

    // Return format: (handler_name move_bytes validator_for_my_move
    //   validator_for_my_move_hash validator_for_their_next_move
    //   validator_for_their_move_hash max_move_size new_mover_share
    //   [their_turn_handler] [message_parser])
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

    // Check if result is a proper list, or an improper list (cons chain)
    let items = match proper_list(allocator.allocator(), result, true) {
        Some(items) => items,
        None => {
            // It might be an improper list - try to walk it
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

    // Check if first item is a non-nil atom with value 0 (MAKE_MOVE code prefix).
    // Nil (empty atom) should NOT trigger offset - it's just empty readable_move.
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
        "clsp/games/calpoker/calpoker_include_calpoker_make_proposal.hex",
    )
    .expect("load make_proposal");
    let parser = read_hex_puzzle(
        allocator,
        "clsp/games/calpoker/calpoker_include_calpoker_parser.hex",
    )
    .expect("load parser");

    let make_proposal_clvm = make_proposal.to_clvm(allocator).unwrap();
    let parser_clvm = parser.to_clvm(allocator).unwrap();

    let bet_args = (BET_SIZE, ()).to_clvm(allocator).unwrap();
    let proposal_result = run_clvm(allocator, make_proposal_clvm, bet_args);

    // proposal_result is a 2-element list: (wire_data local_data)
    let proposal_list = proper_list(allocator.allocator(), proposal_result, true).unwrap();
    assert!(
        proposal_list.len() >= 2,
        "make_proposal returned {} elements",
        proposal_list.len()
    );
    let wire_data = proposal_list[0];
    let local_data = proposal_list[1];

    // wire_data = (bet bet ((amount we_go_first vh im mms is ms)))
    let wire_data_list = proper_list(allocator.allocator(), wire_data, true).unwrap();
    let game_specs_wrapper = proper_list(allocator.allocator(), wire_data_list[2], true).unwrap();
    let game_spec = proper_list(allocator.allocator(), game_specs_wrapper[0], true).unwrap();
    // game_spec = [amount, we_go_first, vh, im, mms, is, ms]
    let initial_validator_hash = game_spec[2];
    let initial_move = game_spec[3];
    let initial_max_move_size = int_from_node(allocator, game_spec[4]);
    let initial_state = game_spec[5];
    let initial_mover_share = int_from_node(allocator, game_spec[6]);

    // local_data = ((handler validator))
    let local_data_list = proper_list(allocator.allocator(), local_data, true).unwrap();
    let hv_list = proper_list(allocator.allocator(), local_data_list[0], true).unwrap();
    assert!(
        hv_list.len() >= 2,
        "handler_validator has {} elements",
        hv_list.len()
    );
    let alice_handler = hv_list[0];
    let alice_validator = hv_list[1];

    // Run parser to get bob's handler and validator
    let parser_result = run_clvm(allocator, parser_clvm, wire_data);
    // parser returns (readable ((validator handler)))
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
    MutateDOutput,
    CheckForAliceTriesToCheat,
}

struct HandlerMove {
    input_move: NodePtr,
    entropy: NodePtr,
    expected_move_bytes: Vec<u8>,
    expected_mover_share: i64,
    test_type: TestType,
}

fn run_handler_game(
    allocator: &mut AllocEncoder,
    lib: &ValidatorLibrary,
    setup: &GameSetup,
    moves: &[HandlerMove],
) {
    // Each player has separate my_turn and their_turn handlers
    // Alice starts as my_turn player (goes first), Bob starts as their_turn player
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

    let mut whose_move: usize = 0; // 0=alice, 1=bob

    for (step_idx, hm) in moves.iter().enumerate() {
        let is_alice = whose_move == 0;
        eprintln!(
            "--- step {step_idx}: {} MY TURN ---",
            if is_alice { "alice" } else { "bob" }
        );

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

        if matches!(hm.test_type, TestType::MutateDOutput) {
            my_turn.new_mover_share = 0;
        }

        let actual_move_bytes = atom_bytes(allocator, my_turn.move_bytes_node);
        assert_eq!(
            actual_move_bytes, hm.expected_move_bytes,
            "step {step_idx}: move bytes mismatch"
        );
        assert_eq!(
            my_turn.new_mover_share, hm.expected_mover_share,
            "step {step_idx}: mover_share mismatch"
        );

        // Use validator_for_my_move_hash to look up the correct validator program
        let (code, validator_result) = run_validator(
            allocator,
            lib,
            my_turn.validator_for_my_move_hash,
            my_turn.move_bytes_node,
            hm.expected_mover_share,
            my_turn.max_move_size,
            state,
            my_turn.validator_for_my_move,
            NodePtr::NIL,
        );
        assert_eq!(
            code,
            MoveCode::MakeMove,
            "step {step_idx}: validator rejected our move"
        );

        let validator_items = proper_list(allocator.allocator(), validator_result, true).unwrap();
        let new_state = validator_items[2];

        // Update mover's state and validators
        if is_alice {
            alice_state = new_state;
            alice_mover_share = my_turn.new_mover_share;
            alice_max_move_size = my_turn.max_move_size;
            alice_their_turn_vp_hash = my_turn.validator_for_their_move_hash;
            alice_their_turn_validator = my_turn.validator_for_their_next_move;
            // my_turn produces a their_turn_handler for alice (to be used when opponent moves)
            alice_their_turn_handler = my_turn.their_turn_handler;
        } else {
            bob_state = new_state;
            bob_mover_share = my_turn.new_mover_share;
            bob_max_move_size = my_turn.max_move_size;
            bob_their_turn_vp_hash = my_turn.validator_for_their_move_hash;
            bob_their_turn_validator = my_turn.validator_for_their_next_move;
            bob_their_turn_handler = my_turn.their_turn_handler;
        }

        // Now the other player's their_turn
        whose_move ^= 1;
        let is_alice_waiter = whose_move == 0;
        eprintln!(
            "--- step {step_idx}: {} THEIR TURN ---",
            if is_alice_waiter { "alice" } else { "bob" }
        );

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

        let effective_mover_share = if matches!(hm.test_type, TestType::CheckForAliceTriesToCheat) {
            0
        } else {
            my_turn.new_mover_share
        };

        // Run validator for the waiter's side
        let (_waiter_code, waiter_validator_result) = run_validator(
            allocator,
            lib,
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

        let waiter_validator_items =
            proper_list(allocator.allocator(), waiter_validator_result, true).unwrap();
        let waiter_new_state = waiter_validator_items[2];

        // Run their_turn handler
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

        // For evil tests, check evidence
        if matches!(hm.test_type, TestType::CheckForAliceTriesToCheat) {
            let evidence_items = proper_list(allocator.allocator(), their_turn.evidence_list, true);
            if let Some(items) = evidence_items {
                let mut found_slash = false;
                for ev in &items {
                    let (ev_code, _) = run_validator(
                        allocator,
                        lib,
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

        // Update waiter: their_turn produces a my_turn handler for the waiting player
        if is_alice_waiter {
            alice_state = waiter_new_state;
            alice_mover_share = effective_mover_share;
            alice_my_turn_handler = their_turn.my_turn_handler;
        } else {
            bob_state = waiter_new_state;
            bob_mover_share = effective_mover_share;
            bob_my_turn_handler = their_turn.my_turn_handler;
        }

        // States should match
        let alice_hex = node_to_hex(allocator, alice_state);
        let bob_hex = node_to_hex(allocator, bob_state);
        assert_eq!(
            alice_hex, bob_hex,
            "step {step_idx}: alice and bob states diverged"
        );
    }
}

fn build_happy_path_moves(allocator: &mut AllocEncoder) -> Vec<HandlerMove> {
    let seed = GameSeed::new(1027);
    let first_move_bytes = sha256_bytes(&seed.alice_seed).to_vec();
    let alice_discards_byte = bitfield_to_byte(&[1, 3, 4, 7]);
    let bob_discards_byte = bitfield_to_byte(&[0, 2, 4, 6]);
    let alice_good_selections = bitfield_to_byte(&[3, 4, 5, 6, 7]);
    let alice_discards_salt = seed.seed[..16].to_vec();
    let good_c_move = {
        let commit = sha256_concat(&[&alice_discards_salt, &alice_discards_byte]);
        let mut v = seed.alice_seed.clone();
        v.extend_from_slice(&commit);
        v
    };
    let e_move_bytes = {
        let mut v = alice_discards_salt.clone();
        v.extend_from_slice(&alice_discards_byte);
        v.extend_from_slice(&alice_good_selections);
        v
    };

    let entropy_seeds: Vec<GameSeed> = (0..5u64).map(|s| GameSeed::new(s + 1027)).collect();

    let entropy0_alice = allocator
        .allocator()
        .new_atom(&entropy_seeds[0].alice_seed)
        .unwrap();
    let entropy0_bob = allocator
        .allocator()
        .new_atom(&entropy_seeds[0].bob_seed)
        .unwrap();
    let entropy0_seed = allocator
        .allocator()
        .new_atom(&entropy_seeds[0].seed)
        .unwrap();

    vec![
        HandlerMove {
            input_move: NodePtr::NIL,
            entropy: entropy0_alice,
            expected_move_bytes: first_move_bytes,
            expected_mover_share: 0,
            test_type: TestType::Normal,
        },
        HandlerMove {
            input_move: NodePtr::NIL,
            entropy: entropy0_bob,
            expected_move_bytes: seed.bob_seed.clone(),
            expected_mover_share: 0,
            test_type: TestType::Normal,
        },
        HandlerMove {
            input_move: {
                let alice_discard_cards: Vec<i64> = vec![14, 38, 48, 51];
                alice_discard_cards.to_clvm(allocator).unwrap()
            },
            entropy: entropy0_seed,
            expected_move_bytes: good_c_move,
            expected_mover_share: 0,
            test_type: TestType::Normal,
        },
        HandlerMove {
            input_move: {
                let bob_discard_cards: Vec<i64> = vec![6, 15, 26, 41];
                bob_discard_cards.to_clvm(allocator).unwrap()
            },
            entropy: entropy0_bob,
            expected_move_bytes: bob_discards_byte,
            expected_mover_share: 0,
            test_type: TestType::Normal,
        },
        HandlerMove {
            input_move: NodePtr::NIL,
            entropy: entropy0_alice,
            expected_move_bytes: e_move_bytes,
            expected_mover_share: 100,
            test_type: TestType::Normal,
        },
    ]
}

fn build_evil_moves(allocator: &mut AllocEncoder) -> Vec<HandlerMove> {
    let mut moves = build_happy_path_moves(allocator);
    moves[3].test_type = TestType::MutateDOutput;
    moves[4].test_type = TestType::CheckForAliceTriesToCheat;
    moves
}

#[test]
fn test_calpoker_handlers_happy_path() {
    let mut allocator = AllocEncoder::new();
    let lib = load_validator_library(&mut allocator);
    let setup = setup_game(&mut allocator);
    let moves = build_happy_path_moves(&mut allocator);
    run_handler_game(&mut allocator, &lib, &setup, &moves);
}

#[test]
fn test_calpoker_handlers_evil_path() {
    let mut allocator = AllocEncoder::new();
    let lib = load_validator_library(&mut allocator);
    let setup = setup_game(&mut allocator);
    let moves = build_evil_moves(&mut allocator);
    run_handler_game(&mut allocator, &lib, &setup, &moves);
}
