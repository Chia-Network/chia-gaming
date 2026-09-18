use crate::common::load_clvm::read_hex_puzzle;
use crate::common::types::{chia_dialect, AllocEncoder, Sha256Input};
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

#[derive(Debug, Clone, Copy, PartialEq)]
enum MoveCode {
    MakeMove = 0,
    Slash = 2,
}

struct ValidatorResult {
    code: MoveCode,
    next_validator_hash: NodePtr,
    new_state: NodePtr,
    next_max_move_size: i64,
}

fn parse_validator_output(allocator: &mut AllocEncoder, result: NodePtr) -> ValidatorResult {
    let items = proper_list(allocator.allocator(), result, true).unwrap();
    if items.is_empty() {
        ValidatorResult {
            code: MoveCode::Slash,
            next_validator_hash: NodePtr::NIL,
            new_state: NodePtr::NIL,
            next_max_move_size: 0,
        }
    } else {
        ValidatorResult {
            code: MoveCode::MakeMove,
            next_validator_hash: items[0],
            new_state: items.get(1).copied().unwrap_or(NodePtr::NIL),
            next_max_move_size: items
                .get(2)
                .map(|node| int_from_node(allocator, *node))
                .unwrap_or(0),
        }
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
) -> ValidatorResult {
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

struct MyTurnResult {
    move_bytes_node: NodePtr,
    new_mover_share: i64,
    their_turn_handler: NodePtr,
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
        (4..=5).contains(&items.len()),
        "my_turn handler returned {} items, expected 4 or 5",
        items.len()
    );

    MyTurnResult {
        move_bytes_node: items[1],
        new_mover_share: int_from_node(allocator, items[2]),
        their_turn_handler: items[3],
    }
}

struct TheirTurnResult {
    evidence_list: NodePtr,
    my_turn_handler: NodePtr,
}

fn parse_their_turn_result(allocator: &mut AllocEncoder, result: NodePtr) -> TheirTurnResult {
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
        evidence_list: items[offset + 1],
        my_turn_handler: if items.len() > offset + 2 {
            items[offset + 2]
        } else {
            NodePtr::NIL
        },
    }
}

fn try_call_their_turn_handler(
    allocator: &mut AllocEncoder,
    handler: NodePtr,
    amount: i64,
    pre_state: NodePtr,
    state: NodePtr,
    move_bytes: NodePtr,
    validation_program_hash: NodePtr,
    mover_share: i64,
) -> Result<TheirTurnResult, String> {
    let amount_node = amount.to_clvm(allocator).unwrap();
    let ms_node = mover_share.to_clvm(allocator).unwrap();
    let a = allocator.allocator();
    let tail = a.new_pair(ms_node, NodePtr::NIL).unwrap();
    let tail = a.new_pair(validation_program_hash, tail).unwrap();
    let tail = a.new_pair(move_bytes, tail).unwrap();
    let tail = a.new_pair(state, tail).unwrap();
    let tail = a.new_pair(pre_state, tail).unwrap();
    let args = a.new_pair(amount_node, tail).unwrap();

    match run_program(allocator.allocator(), &chia_dialect(), handler, args, 0) {
        Ok(reduction) => Ok(parse_their_turn_result(allocator, reduction.1)),
        Err(e) => Err(format!("CLVM error: {e:?}")),
    }
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
    try_call_their_turn_handler(
        allocator,
        handler,
        amount,
        pre_state,
        state,
        move_bytes,
        validation_program_hash,
        mover_share,
    )
    .expect("their_turn handler failed")
}

struct GameSetup {
    alice_handler: NodePtr,
    bob_handler: NodePtr,
    validators: Vec<NodePtr>,
    initial_validator_hash: NodePtr,
    initial_state: NodePtr,
    initial_max_move_size: i64,
    initial_mover_share: i64,
}

fn setup_game(allocator: &mut AllocEncoder) -> GameSetup {
    let factory = read_hex_puzzle(
        allocator,
        "games/calpoker/clsp/factory_calpoker_factory.hex",
    )
    .expect("load factory");
    let factory_clvm = factory.to_clvm(allocator).unwrap();
    let parameters = (BET_SIZE, (BET_SIZE, (BET_SIZE, ())))
        .to_clvm(allocator)
        .unwrap();
    let result = run_clvm(allocator, factory_clvm, parameters);
    let envelope = proper_list(allocator.allocator(), result, true).unwrap();
    assert_eq!(int_from_node(allocator, envelope[0]), 1);
    let records = proper_list(allocator.allocator(), envelope[1], true).unwrap();
    assert_eq!(records.len(), 1, "Calpoker factory must return one record");
    let record = proper_list(allocator.allocator(), records[0], true).unwrap();
    assert_eq!(record.len(), 11, "factory record must have 11 fields");
    assert_eq!(int_from_node(allocator, record[0]), BET_SIZE);
    assert_eq!(int_from_node(allocator, record[1]), BET_SIZE);
    assert_eq!(
        int_from_node(allocator, record[0]) + int_from_node(allocator, record[1]),
        AMOUNT
    );
    assert_eq!(int_from_node(allocator, record[2]), 1);
    let validators = proper_list(allocator.allocator(), record[9], true)
        .expect("factory validators must be a proper list");
    assert!(
        !validators.is_empty(),
        "factory validators must be nonempty"
    );
    let initial_validator_hash_bytes =
        clvm_utils::tree_hash(allocator.allocator(), validators[0]).to_bytes();
    let initial_validator_hash = allocator
        .allocator()
        .new_atom(&initial_validator_hash_bytes)
        .unwrap();

    GameSetup {
        alice_handler: record[7],
        bob_handler: record[8],
        validators,
        initial_validator_hash,
        initial_max_move_size: int_from_node(allocator, record[4]),
        initial_state: record[5],
        initial_mover_share: int_from_node(allocator, record[6]),
    }
}

fn validator_for_hash(
    allocator: &mut AllocEncoder,
    validators: &[NodePtr],
    hash: NodePtr,
) -> NodePtr {
    let hash_bytes = atom_bytes(allocator, hash);
    validators
        .iter()
        .copied()
        .find(|program| {
            hash_bytes == clvm_utils::tree_hash(allocator.allocator(), *program).to_bytes()
        })
        .unwrap_or_else(|| {
            panic!(
                "validator hash {} missing from factory list",
                hex::encode(hash_bytes)
            )
        })
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

    let mut alice_validator =
        validator_for_hash(allocator, &setup.validators, setup.initial_validator_hash);
    let mut bob_validator = alice_validator;
    let mut alice_vp_hash = setup.initial_validator_hash;
    let mut bob_vp_hash = setup.initial_validator_hash;

    let mut whose_move: usize = 0;

    for (step_idx, hm) in moves.iter().enumerate() {
        let is_alice = whose_move == 0;

        let (handler, state, mover_share, validator, validator_hash, max_move_size) = if is_alice {
            (
                alice_my_turn_handler,
                alice_state,
                alice_mover_share,
                alice_validator,
                alice_vp_hash,
                alice_max_move_size,
            )
        } else {
            (
                bob_my_turn_handler,
                bob_state,
                bob_mover_share,
                bob_validator,
                bob_vp_hash,
                bob_max_move_size,
            )
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

        let mover_validation = run_validator(
            allocator,
            validator_hash,
            my_turn.move_bytes_node,
            hm.expected_mover_share,
            max_move_size,
            state,
            validator,
            NodePtr::NIL,
        );
        assert_eq!(
            mover_validation.code,
            MoveCode::MakeMove,
            "step {step_idx}: validator rejected our move"
        );
        let is_terminal = mover_validation.next_validator_hash == NodePtr::NIL;
        assert_eq!(
            is_terminal,
            my_turn.their_turn_handler == NodePtr::NIL,
            "step {step_idx}: terminal validator hash and next handler disagree"
        );

        if is_alice {
            alice_state = mover_validation.new_state;
            alice_mover_share = my_turn.new_mover_share;
            alice_max_move_size = mover_validation.next_max_move_size;
            alice_vp_hash = mover_validation.next_validator_hash;
            if !is_terminal {
                alice_validator = validator_for_hash(allocator, &setup.validators, alice_vp_hash);
            }
            alice_their_turn_handler = my_turn.their_turn_handler;
        } else {
            bob_state = mover_validation.new_state;
            bob_mover_share = my_turn.new_mover_share;
            bob_max_move_size = mover_validation.next_max_move_size;
            bob_vp_hash = mover_validation.next_validator_hash;
            if !is_terminal {
                bob_validator = validator_for_hash(allocator, &setup.validators, bob_vp_hash);
            }
            bob_their_turn_handler = my_turn.their_turn_handler;
        }

        whose_move ^= 1;
        let is_alice_waiter = whose_move == 0;

        let (waiter_handler, waiter_state, waiter_vp_hash, waiter_max_move_size, waiter_validator) =
            if is_alice_waiter {
                (
                    alice_their_turn_handler,
                    alice_state,
                    alice_vp_hash,
                    alice_max_move_size,
                    alice_validator,
                )
            } else {
                (
                    bob_their_turn_handler,
                    bob_state,
                    bob_vp_hash,
                    bob_max_move_size,
                    bob_validator,
                )
            };

        let effective_mover_share = if matches!(hm.test_type, TestType::CheckForAliceTriesToCheat) {
            0
        } else {
            my_turn.new_mover_share
        };

        let waiter_validation = run_validator(
            allocator,
            waiter_vp_hash,
            my_turn.move_bytes_node,
            effective_mover_share,
            waiter_max_move_size,
            waiter_state,
            waiter_validator,
            NodePtr::NIL,
        );
        let waiter_terminal = waiter_validation.next_validator_hash == NodePtr::NIL;
        let their_turn = call_their_turn_handler(
            allocator,
            waiter_handler,
            AMOUNT,
            waiter_state,
            if waiter_terminal {
                NodePtr::NIL
            } else {
                waiter_validation.new_state
            },
            my_turn.move_bytes_node,
            waiter_vp_hash,
            effective_mover_share,
        );

        if matches!(hm.test_type, TestType::CheckForAliceTriesToCheat) {
            let evidence_items = proper_list(allocator.allocator(), their_turn.evidence_list, true);
            if let Some(items) = evidence_items {
                let found_slash = items.iter().any(|ev| {
                    run_validator(
                        allocator,
                        waiter_vp_hash,
                        my_turn.move_bytes_node,
                        effective_mover_share,
                        waiter_max_move_size,
                        waiter_state,
                        waiter_validator,
                        *ev,
                    )
                    .code
                        == MoveCode::Slash
                });
                assert!(found_slash, "step {step_idx}: expected slash evidence");
            }
        }

        if is_alice_waiter {
            alice_state = waiter_validation.new_state;
            alice_mover_share = effective_mover_share;
            alice_max_move_size = waiter_validation.next_max_move_size;
            alice_vp_hash = waiter_validation.next_validator_hash;
            if !waiter_terminal {
                alice_validator = validator_for_hash(allocator, &setup.validators, alice_vp_hash);
                alice_my_turn_handler = their_turn.my_turn_handler;
            }
        } else {
            bob_state = waiter_validation.new_state;
            bob_mover_share = effective_mover_share;
            bob_max_move_size = waiter_validation.next_max_move_size;
            bob_vp_hash = waiter_validation.next_validator_hash;
            if !waiter_terminal {
                bob_validator = validator_for_hash(allocator, &setup.validators, bob_vp_hash);
                bob_my_turn_handler = their_turn.my_turn_handler;
            }
        }

        if !waiter_terminal {
            let alice_hex = node_to_hex(allocator, alice_state);
            let bob_hex = node_to_hex(allocator, bob_state);
            assert_eq!(
                alice_hex, bob_hex,
                "step {step_idx}: alice and bob states diverged"
            );
        }
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

struct BobTerminalContext {
    pre_state: NodePtr,
    validation_program: NodePtr,
    validation_program_hash: NodePtr,
    max_move_size: i64,
}

fn bob_terminal_context_after_step_d(
    allocator: &mut AllocEncoder,
    setup: &GameSetup,
) -> BobTerminalContext {
    let moves = build_happy_path_moves(allocator);

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

    let mut alice_validator =
        validator_for_hash(allocator, &setup.validators, setup.initial_validator_hash);
    let mut bob_validator = alice_validator;
    let mut alice_vp_hash = setup.initial_validator_hash;
    let mut bob_vp_hash = setup.initial_validator_hash;

    let mut whose_move: usize = 0; // 0=alice, 1=bob

    for hm in moves.iter().take(4) {
        let is_alice = whose_move == 0;
        let (handler, state, mover_share, validator, validator_hash, max_move_size) = if is_alice {
            (
                alice_my_turn_handler,
                alice_state,
                alice_mover_share,
                alice_validator,
                alice_vp_hash,
                alice_max_move_size,
            )
        } else {
            (
                bob_my_turn_handler,
                bob_state,
                bob_mover_share,
                bob_validator,
                bob_vp_hash,
                bob_max_move_size,
            )
        };

        let my_turn = call_my_turn_handler(
            allocator,
            handler,
            hm.input_move,
            AMOUNT,
            state,
            mover_share,
            hm.entropy,
        );

        let actual_move_bytes = atom_bytes(allocator, my_turn.move_bytes_node);
        assert_eq!(actual_move_bytes, hm.expected_move_bytes);
        assert_eq!(my_turn.new_mover_share, hm.expected_mover_share);

        let validator_result = run_validator(
            allocator,
            validator_hash,
            my_turn.move_bytes_node,
            hm.expected_mover_share,
            max_move_size,
            state,
            validator,
            NodePtr::NIL,
        );
        assert_eq!(validator_result.code, MoveCode::MakeMove);

        if is_alice {
            alice_state = validator_result.new_state;
            alice_mover_share = my_turn.new_mover_share;
            alice_max_move_size = validator_result.next_max_move_size;
            alice_vp_hash = validator_result.next_validator_hash;
            alice_validator = validator_for_hash(allocator, &setup.validators, alice_vp_hash);
            alice_their_turn_handler = my_turn.their_turn_handler;
        } else {
            bob_state = validator_result.new_state;
            bob_mover_share = my_turn.new_mover_share;
            bob_max_move_size = validator_result.next_max_move_size;
            bob_vp_hash = validator_result.next_validator_hash;
            bob_validator = validator_for_hash(allocator, &setup.validators, bob_vp_hash);
            bob_their_turn_handler = my_turn.their_turn_handler;
        }

        whose_move ^= 1;
        let is_alice_waiter = whose_move == 0;
        let (waiter_handler, waiter_state, waiter_vp_hash) = if is_alice_waiter {
            (alice_their_turn_handler, alice_state, alice_vp_hash)
        } else {
            (bob_their_turn_handler, bob_state, bob_vp_hash)
        };

        let waiter_validator_result = run_validator(
            allocator,
            waiter_vp_hash,
            my_turn.move_bytes_node,
            hm.expected_mover_share,
            if is_alice_waiter {
                alice_max_move_size
            } else {
                bob_max_move_size
            },
            waiter_state,
            if is_alice_waiter {
                alice_validator
            } else {
                bob_validator
            },
            NodePtr::NIL,
        );
        assert_eq!(waiter_validator_result.code, MoveCode::MakeMove);
        let waiter_new_state = waiter_validator_result.new_state;

        let their_turn = call_their_turn_handler(
            allocator,
            waiter_handler,
            AMOUNT,
            waiter_state,
            waiter_new_state,
            my_turn.move_bytes_node,
            waiter_vp_hash,
            hm.expected_mover_share,
        );

        if is_alice_waiter {
            alice_state = waiter_new_state;
            alice_mover_share = hm.expected_mover_share;
            alice_max_move_size = waiter_validator_result.next_max_move_size;
            alice_vp_hash = waiter_validator_result.next_validator_hash;
            alice_validator = validator_for_hash(allocator, &setup.validators, alice_vp_hash);
            alice_my_turn_handler = their_turn.my_turn_handler;
        } else {
            bob_state = waiter_new_state;
            bob_mover_share = hm.expected_mover_share;
            bob_max_move_size = waiter_validator_result.next_max_move_size;
            bob_vp_hash = waiter_validator_result.next_validator_hash;
            bob_validator = validator_for_hash(allocator, &setup.validators, bob_vp_hash);
            bob_my_turn_handler = their_turn.my_turn_handler;
        }
    }

    BobTerminalContext {
        pre_state: bob_state,
        validation_program: bob_validator,
        validation_program_hash: bob_vp_hash,
        max_move_size: bob_max_move_size,
    }
}

fn calpoker_factory_succeeds(allocator: &mut AllocEncoder, args: NodePtr) -> bool {
    let factory = read_hex_puzzle(
        allocator,
        "games/calpoker/clsp/factory_calpoker_factory.hex",
    )
    .expect("load factory");
    let factory_clvm = factory.to_clvm(allocator).unwrap();
    run_program(
        allocator.allocator(),
        &chia_dialect(),
        factory_clvm,
        args,
        0,
    )
    .is_ok()
}

#[test]
fn test_calpoker_factory_rejects_malformed_parameters() {
    let mut allocator = AllocEncoder::new();

    let valid_args = (BET_SIZE, (BET_SIZE, (BET_SIZE, ())))
        .to_clvm(&mut allocator)
        .unwrap();
    assert!(
        calpoker_factory_succeeds(&mut allocator, valid_args),
        "valid uniform arguments should be accepted"
    );

    let zero_args = (BET_SIZE, (BET_SIZE, (0i64, ())))
        .to_clvm(&mut allocator)
        .unwrap();
    assert!(
        !calpoker_factory_succeeds(&mut allocator, zero_args),
        "zero stake must be rejected"
    );

    let insufficient = (BET_SIZE - 1, (BET_SIZE, (BET_SIZE, ())))
        .to_clvm(&mut allocator)
        .unwrap();
    assert!(
        calpoker_factory_succeeds(&mut allocator, insufficient),
        "insufficient reserves must return shortage flags, not raise"
    );

    let malformed_parameters = (BET_SIZE, (BET_SIZE, ((BET_SIZE, ()), ())))
        .to_clvm(&mut allocator)
        .unwrap();
    assert!(!calpoker_factory_succeeds(
        &mut allocator,
        malformed_parameters
    ));

    let extra_parameter = (BET_SIZE, (BET_SIZE, (BET_SIZE, (7i64, ()))))
        .to_clvm(&mut allocator)
        .unwrap();
    assert!(
        !calpoker_factory_succeeds(&mut allocator, extra_parameter),
        "arguments must be a three-element proper list"
    );
}

#[test]
fn test_calpoker_handlers_happy_path() {
    let mut allocator = AllocEncoder::new();
    let setup = setup_game(&mut allocator);
    let moves = build_happy_path_moves(&mut allocator);
    run_handler_game(&mut allocator, &setup, &moves);
}

#[test]
fn test_calpoker_handlers_evil_path() {
    let mut allocator = AllocEncoder::new();
    let setup = setup_game(&mut allocator);
    let moves = build_evil_moves(&mut allocator);
    run_handler_game(&mut allocator, &setup, &moves);
}

#[test]
fn test_calpoker_terminal_nil_evidence_precheck_slashes_short_final_move() {
    let mut allocator = AllocEncoder::new();
    let setup = setup_game(&mut allocator);
    let ctx = bob_terminal_context_after_step_d(&mut allocator, &setup);
    let good_final_move = build_happy_path_moves(&mut allocator)[4]
        .expected_move_bytes
        .clone();
    let short_final_move = &good_final_move[..17];
    assert!(
        short_final_move.len() <= ctx.max_move_size as usize,
        "test move must satisfy referee max_move_size envelope"
    );

    let short_move_node = allocator.allocator().new_atom(short_final_move).unwrap();
    let result = run_validator(
        &mut allocator,
        ctx.validation_program_hash,
        short_move_node,
        100,
        ctx.max_move_size,
        ctx.pre_state,
        ctx.validation_program,
        NodePtr::NIL,
    );
    assert_eq!(
        result.code,
        MoveCode::Slash,
        "the step-e validator should classify the short final move as slashable"
    );
}

pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
    vec![
        (
            "test_calpoker_factory_rejects_malformed_parameters",
            &test_calpoker_factory_rejects_malformed_parameters,
        ),
        (
            "test_calpoker_handlers_happy_path",
            &test_calpoker_handlers_happy_path,
        ),
        (
            "test_calpoker_handlers_evil_path",
            &test_calpoker_handlers_evil_path,
        ),
        (
            "test_calpoker_terminal_nil_evidence_precheck_slashes_short_final_move",
            &test_calpoker_terminal_nil_evidence_precheck_slashes_short_final_move,
        ),
    ]
}
