#![allow(non_snake_case)]

use crate::channel_state::game_handler::{GameHandler, MyTurnInputs};
use crate::channel_state::game_start_info::GameStartInfo;
use crate::channel_state::types::{Evidence, ReadableMove, ValidationProgramRegistry};
use crate::common::constants::AGG_SIG_ME_ADDITIONAL_DATA;
use crate::common::load_clvm::read_hex_puzzle;
use crate::common::standard_coin::{sign_reward_payout, ChiaIdentity};
use crate::common::types::{
    chia_dialect, Aggsig, AllocEncoder, Amount, Error, GameID, Hash, PrivateKey, Program,
    ProgramRef, Puzzle, Sha256Input, Sha256tree, Timeout,
};
use crate::games::krunk_dict_tree::build_signed_dict_tree_from_bytes;
use crate::referee::Referee;
use crate::utils::proper_list;

use std::rc::Rc;

use chia_protocol::Bytes;
use clvm_traits::{clvm_curried_args, ToClvm};
use clvm_utils::CurriedProgram;
use clvmr::allocator::{NodePtr, SExp};
use clvmr::run_program;

const BET_SIZE: i64 = 100;
const AMOUNT: i64 = BET_SIZE;

fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    *Sha256Input::Bytes(data).hash().bytes()
}

fn run_clvm(allocator: &mut AllocEncoder, program: NodePtr, args: NodePtr) -> NodePtr {
    run_program(allocator.allocator(), &chia_dialect(), program, args, 0)
        .expect("CLVM run failed")
        .1
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

fn int_list_from_node(allocator: &mut AllocEncoder, node: NodePtr) -> Vec<i64> {
    proper_list(allocator.allocator(), node, true)
        .expect("expected proper integer list")
        .into_iter()
        .map(|item| int_from_node(allocator, item))
        .collect()
}

fn atom(allocator: &mut AllocEncoder, bytes: &[u8]) -> NodePtr {
    allocator.allocator().new_atom(bytes).unwrap()
}

fn assert_clvm_eq(allocator: &mut AllocEncoder, left: NodePtr, right: NodePtr, message: &str) {
    let left_hash = clvm_utils::tree_hash(allocator.allocator(), left);
    let right_hash = clvm_utils::tree_hash(allocator.allocator(), right);
    assert_eq!(left_hash, right_hash, "{message}");
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum MoveCode {
    MakeMove = 0,
    Slash = 2,
}

struct ValidatorResult {
    code: MoveCode,
    output: NodePtr,
    next_validator_hash: NodePtr,
    new_state: NodePtr,
    next_max_move_size: i64,
}

fn parse_validator_output(allocator: &mut AllocEncoder, result: NodePtr) -> ValidatorResult {
    let items = proper_list(allocator.allocator(), result, true).unwrap();
    if items.is_empty() {
        ValidatorResult {
            code: MoveCode::Slash,
            output: result,
            next_validator_hash: NodePtr::NIL,
            new_state: NodePtr::NIL,
            next_max_move_size: 0,
        }
    } else {
        ValidatorResult {
            code: MoveCode::MakeMove,
            output: result,
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
    mover_share: i64,
    entropy: NodePtr,
) -> MyTurnResult {
    let amount_node = amount.to_clvm(allocator).unwrap();
    let ms_node = mover_share.to_clvm(allocator).unwrap();
    let a = allocator.allocator();
    let tail = a.new_pair(entropy, NodePtr::NIL).unwrap();
    let tail = a.new_pair(ms_node, tail).unwrap();
    let tail = a.new_pair(state, tail).unwrap();
    let tail = a.new_pair(amount_node, tail).unwrap();
    let args = a.new_pair(local_move, tail).unwrap();

    let result = run_clvm(allocator, handler, args);
    let items = proper_list(allocator.allocator(), result, true).unwrap();
    assert!(
        (4..=5).contains(&items.len()),
        "my_turn returned {} items, expected 4 or 5",
        items.len()
    );

    MyTurnResult {
        move_bytes_node: items[1],
        new_mover_share: int_from_node(allocator, items[2]),
        their_turn_handler: items[3],
    }
}

struct TheirTurnResult {
    readable_move: NodePtr,
    evidence_list: NodePtr,
    my_turn_handler: NodePtr,
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
    let items = proper_list(allocator.allocator(), result, true).unwrap();
    assert!(
        items.len() >= 2,
        "their_turn returned {} items",
        items.len()
    );

    TheirTurnResult {
        readable_move: items[0],
        evidence_list: items[1],
        my_turn_handler: if items.len() > 2 {
            items[2]
        } else {
            NodePtr::NIL
        },
    }
}

struct GameSetup {
    alice_handler: NodePtr,
    bob_handler: NodePtr,
    validators: Vec<NodePtr>,
    initial_validator_hash: NodePtr,
    proposal_my_contribution: i64,
    proposal_their_contribution: i64,
    proposal_amount: i64,
    initial_state: NodePtr,
    initial_max_move_size: i64,
    initial_mover_share: i64,
}

/// Builds the dictionary-curried factory and extracts slot 0, where player A
/// is Alice (the word picker).
fn setup_game(allocator: &mut AllocEncoder, dictionary: Vec<Bytes>) -> GameSetup {
    let factory_raw = read_hex_puzzle(allocator, "games/krunk/clsp/factory_krunk_factory.hex")
        .expect("load factory");

    let n_words = dictionary.len();
    let sigs: Vec<Aggsig> = (0..=n_words).map(|_| Aggsig::default()).collect();
    let dict_tree =
        build_signed_dict_tree_from_bytes(allocator, &dictionary, &sigs).expect("build dict tree");
    let dict_pubkey = allocator.allocator().new_atom(&[0xAA; 48]).unwrap();
    let factory_curried = CurriedProgram {
        program: factory_raw,
        args: clvm_curried_args!(dict_pubkey, dict_tree),
    }
    .to_clvm(allocator)
    .unwrap();
    let arguments = (BET_SIZE, (BET_SIZE, (BET_SIZE, ())))
        .to_clvm(allocator)
        .unwrap();
    let result = run_clvm(allocator, factory_curried, arguments);
    let envelope = proper_list(allocator.allocator(), result, true).unwrap();
    let records = proper_list(allocator.allocator(), envelope[1], true).unwrap();
    assert_eq!(records.len(), 2, "Krunk factory must return two records");
    let game_spec = proper_list(allocator.allocator(), records[0], true).unwrap();
    assert_eq!(game_spec.len(), 11, "factory record must have 11 fields");
    let validators = proper_list(allocator.allocator(), game_spec[9], true)
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
    let proposal_my_contribution = int_from_node(allocator, game_spec[0]);
    let proposal_their_contribution = int_from_node(allocator, game_spec[1]);

    GameSetup {
        alice_handler: game_spec[7],
        bob_handler: game_spec[8],
        validators,
        initial_validator_hash,
        proposal_my_contribution,
        proposal_their_contribution,
        proposal_amount: proposal_my_contribution + proposal_their_contribution,
        initial_state: game_spec[5],
        initial_max_move_size: int_from_node(allocator, game_spec[4]),
        initial_mover_share: int_from_node(allocator, game_spec[6]),
    }
}

fn validator_for_hash(
    allocator: &mut AllocEncoder,
    validators: &[NodePtr],
    hash: NodePtr,
) -> NodePtr {
    let hash_bytes = allocator.allocator().atom(hash).to_vec();
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
struct ValidatorCursor {
    program: NodePtr,
    hash: NodePtr,
    max_move_size: i64,
}

fn initial_validator_cursor(allocator: &mut AllocEncoder, setup: &GameSetup) -> ValidatorCursor {
    ValidatorCursor {
        program: validator_for_hash(allocator, &setup.validators, setup.initial_validator_hash),
        hash: setup.initial_validator_hash,
        max_move_size: setup.initial_max_move_size,
    }
}

fn advance_validator_cursor(
    allocator: &mut AllocEncoder,
    setup: &GameSetup,
    cursor: &mut ValidatorCursor,
    result: &ValidatorResult,
) {
    assert_eq!(result.code, MoveCode::MakeMove);
    cursor.hash = result.next_validator_hash;
    cursor.max_move_size = result.next_max_move_size;
    if cursor.hash != NodePtr::NIL {
        cursor.program = validator_for_hash(allocator, &setup.validators, cursor.hash);
    }
}

fn validate_terminal_move(
    allocator: &mut AllocEncoder,
    cursor: ValidatorCursor,
    state: NodePtr,
    my_turn: &MyTurnResult,
) -> ValidatorResult {
    let result = run_validator(
        allocator,
        cursor.hash,
        my_turn.move_bytes_node,
        my_turn.new_mover_share,
        cursor.max_move_size,
        state,
        cursor.program,
        NodePtr::NIL,
    );
    assert_eq!(result.code, MoveCode::MakeMove);
    assert_eq!(
        result.next_validator_hash,
        NodePtr::NIL,
        "terminal validator must return nil next hash"
    );
    assert_eq!(
        my_turn.their_turn_handler,
        NodePtr::NIL,
        "nil next validator hash must agree with nil next handler"
    );
    result
}

fn make_entropy(allocator: &mut AllocEncoder, seed: &str) -> NodePtr {
    atom(allocator, &sha256_bytes(seed.as_bytes()))
}

fn test_dictionary() -> Vec<Bytes> {
    vec![
        Bytes::from(b"crane".to_vec()),
        Bytes::from(b"slate".to_vec()),
        Bytes::from(b"trace".to_vec()),
        Bytes::from(b"world".to_vec()),
        Bytes::from(b"zzzzz".to_vec()),
    ]
}

fn factory_puzzle(allocator: &mut AllocEncoder, dictionary: &[Bytes]) -> Puzzle {
    let factory_raw = read_hex_puzzle(allocator, "games/krunk/clsp/factory_krunk_factory.hex")
        .expect("load factory");
    let sigs: Vec<Aggsig> = (0..=dictionary.len()).map(|_| Aggsig::default()).collect();
    let dict_tree =
        build_signed_dict_tree_from_bytes(allocator, dictionary, &sigs).expect("build dict tree");
    let dict_pubkey = allocator.allocator().new_atom(&[0xAA; 48]).unwrap();
    let factory = CurriedProgram {
        program: factory_raw,
        args: clvm_curried_args!(dict_pubkey, dict_tree),
    }
    .to_clvm(allocator)
    .unwrap();
    Puzzle::from_nodeptr(allocator, factory).unwrap()
}

fn test_krunk_setup_game() {
    let mut allocator = AllocEncoder::new();
    let setup = setup_game(&mut allocator, test_dictionary());
    assert_eq!(setup.proposal_my_contribution, BET_SIZE);
    assert_eq!(setup.proposal_their_contribution, 0);
    assert_eq!(setup.proposal_amount, BET_SIZE);
    assert_eq!(setup.initial_max_move_size, 32);
    assert_eq!(setup.initial_mover_share, 0);
}

fn test_krunk_guesser_funds_zero() {
    let mut allocator = AllocEncoder::new();
    let factory = factory_puzzle(&mut allocator, &test_dictionary());
    let factory_clvm = factory.to_clvm(&mut allocator).unwrap();
    let arguments = (BET_SIZE, (BET_SIZE, (BET_SIZE, ())))
        .to_clvm(&mut allocator)
        .unwrap();
    let result = run_clvm(&mut allocator, factory_clvm, arguments);
    let envelope = proper_list(allocator.allocator(), result, true).unwrap();
    let records = proper_list(allocator.allocator(), envelope[1], true).unwrap();
    let slot0 = proper_list(allocator.allocator(), records[0], true).unwrap();
    let slot1 = proper_list(allocator.allocator(), records[1], true).unwrap();
    assert_eq!(slot0.len(), 11);
    assert_eq!(slot1.len(), 11);
    assert_eq!(int_from_node(&mut allocator, slot0[0]), BET_SIZE);
    assert_eq!(int_from_node(&mut allocator, slot0[1]), 0);
    assert_eq!(
        int_from_node(&mut allocator, slot0[0]) + int_from_node(&mut allocator, slot0[1]),
        BET_SIZE
    );
    assert_eq!(int_from_node(&mut allocator, slot0[2]), 1);
    assert_eq!(int_from_node(&mut allocator, slot0[3]), 0);
    assert_eq!(int_from_node(&mut allocator, slot0[4]), 32);
    assert_eq!(int_from_node(&mut allocator, slot0[6]), 0);
    assert_eq!(int_from_node(&mut allocator, slot1[0]), 0);
    assert_eq!(int_from_node(&mut allocator, slot1[1]), BET_SIZE);
    assert_eq!(
        int_from_node(&mut allocator, slot1[0]) + int_from_node(&mut allocator, slot1[1]),
        BET_SIZE
    );
    assert_eq!(int_from_node(&mut allocator, slot1[2]), 0);
    assert_eq!(int_from_node(&mut allocator, slot1[3]), 0);
    assert_eq!(int_from_node(&mut allocator, slot1[4]), 32);
    assert_eq!(int_from_node(&mut allocator, slot1[6]), 0);
    assert_clvm_eq(
        &mut allocator,
        slot0[5],
        slot1[5],
        "initial states must match",
    );
    assert_clvm_eq(
        &mut allocator,
        slot0[7],
        slot1[7],
        "Alice my-turn handlers must match",
    );
    assert_clvm_eq(
        &mut allocator,
        slot0[8],
        slot1[8],
        "Bob their-turn handlers must match",
    );
    let slot0_validators = proper_list(allocator.allocator(), slot0[9], true)
        .expect("slot 0 validators must be a proper list");
    let slot1_validators = proper_list(allocator.allocator(), slot1[9], true)
        .expect("slot 1 validators must be a proper list");
    assert!(!slot0_validators.is_empty());
    assert!(!slot1_validators.is_empty());
    assert_clvm_eq(&mut allocator, slot0[9], slot1[9], "validators must match");
}

fn test_krunk_rejects_malformed_economics() {
    let mut allocator = AllocEncoder::new();
    let dictionary = test_dictionary();
    let factory = factory_puzzle(&mut allocator, &dictionary);
    let factory_clvm = factory.to_clvm(&mut allocator).unwrap();

    let zero = (BET_SIZE, (BET_SIZE, (0i64, ())))
        .to_clvm(&mut allocator)
        .unwrap();
    assert!(run_program(
        allocator.allocator(),
        &chia_dialect(),
        factory_clvm,
        zero,
        0,
    )
    .is_err());

    let non_multiple = (BET_SIZE, (BET_SIZE, (101i64, ())))
        .to_clvm(&mut allocator)
        .unwrap();
    assert!(run_program(
        allocator.allocator(),
        &chia_dialect(),
        factory_clvm,
        non_multiple,
        0,
    )
    .is_err());

    let unequal = (BET_SIZE - 1, (BET_SIZE, (BET_SIZE, ())))
        .to_clvm(&mut allocator)
        .unwrap();
    assert!(run_program(
        allocator.allocator(),
        &chia_dialect(),
        factory_clvm,
        unequal,
        0,
    )
    .is_ok());
}

fn assert_not_in_dictionary_rejection(
    allocator: &mut AllocEncoder,
    handler: NodePtr,
    state: NodePtr,
    word: &[u8],
) {
    let handler = GameHandler::my_handler_from_nodeptr(allocator, handler).unwrap();
    let word_node = atom(allocator, word);
    let readable = ReadableMove::from_program(Rc::new(
        Program::from_nodeptr(allocator, word_node).unwrap(),
    ));
    let state = Program::from_nodeptr(allocator, state).unwrap().into();
    let error = handler
        .call_my_turn_handler(
            allocator,
            &MyTurnInputs {
                readable_new_move: readable,
                entropy: Hash::default(),
                amount: Amount::new(AMOUNT as u64),
                last_mover_share: Amount::default(),
                state,
            },
        )
        .unwrap_err();
    match error {
        Error::GameMoveRejected { tag, message } => {
            assert_eq!(tag, b"not_in_dictionary");
            assert_eq!(message, word);
        }
        other => panic!("expected GameMoveRejected, got {other:?}"),
    }
}

fn test_krunk_invalid_words_are_typed_rejections() {
    let mut allocator = AllocEncoder::new();
    let setup = setup_game(&mut allocator, test_dictionary());
    assert_not_in_dictionary_rejection(
        &mut allocator,
        setup.alice_handler,
        setup.initial_state,
        b"xxxxx",
    );

    let alice_word = atom(&mut allocator, b"crane");
    let entropy = make_entropy(&mut allocator, "typed_rejection_salt");
    let mut validator = initial_validator_cursor(&mut allocator, &setup);
    let alice_commit = call_my_turn_handler(
        &mut allocator,
        setup.alice_handler,
        alice_word,
        AMOUNT,
        setup.initial_state,
        0,
        entropy,
    );
    let val_result = run_validator(
        &mut allocator,
        validator.hash,
        alice_commit.move_bytes_node,
        0,
        validator.max_move_size,
        setup.initial_state,
        validator.program,
        NodePtr::NIL,
    );
    let state_after_commit = val_result.new_state;
    let bob_receive = call_their_turn_handler(
        &mut allocator,
        setup.bob_handler,
        AMOUNT,
        setup.initial_state,
        state_after_commit,
        alice_commit.move_bytes_node,
        validator.hash,
        0,
    );
    advance_validator_cursor(&mut allocator, &setup, &mut validator, &val_result);
    assert_not_in_dictionary_rejection(
        &mut allocator,
        bob_receive.my_turn_handler,
        state_after_commit,
        b"xxxxx",
    );
}

fn test_krunk_happy_path_correct_guess() {
    let mut allocator = AllocEncoder::new();
    let setup = setup_game(&mut allocator, test_dictionary());

    let alice_word = atom(&mut allocator, b"crane");
    let bob_guess = atom(&mut allocator, b"crane");
    let entropy = make_entropy(&mut allocator, "alice_salt_seed");
    let mut validator = initial_validator_cursor(&mut allocator, &setup);

    let alice_commit = call_my_turn_handler(
        &mut allocator,
        setup.alice_handler,
        alice_word,
        AMOUNT,
        setup.initial_state,
        setup.initial_mover_share,
        entropy,
    );
    assert_eq!(alice_commit.new_mover_share, 0);

    let val_result = run_validator(
        &mut allocator,
        validator.hash,
        alice_commit.move_bytes_node,
        0,
        validator.max_move_size,
        setup.initial_state,
        validator.program,
        NodePtr::NIL,
    );
    let state_after_commit = val_result.new_state;

    let bob_receive = call_their_turn_handler(
        &mut allocator,
        setup.bob_handler,
        AMOUNT,
        setup.initial_state,
        state_after_commit,
        alice_commit.move_bytes_node,
        validator.hash,
        0,
    );
    advance_validator_cursor(&mut allocator, &setup, &mut validator, &val_result);

    let bob_entropy = make_entropy(&mut allocator, "bob_entropy");
    let bob_move = call_my_turn_handler(
        &mut allocator,
        bob_receive.my_turn_handler,
        bob_guess,
        AMOUNT,
        state_after_commit,
        0,
        bob_entropy,
    );
    assert_eq!(validator.max_move_size, 5);

    let after_guess = run_validator(
        &mut allocator,
        validator.hash,
        bob_move.move_bytes_node,
        0,
        validator.max_move_size,
        state_after_commit,
        validator.program,
        NodePtr::NIL,
    );
    let state_after_guess = after_guess.new_state;

    let alice_receive = call_their_turn_handler(
        &mut allocator,
        alice_commit.their_turn_handler,
        AMOUNT,
        state_after_commit,
        state_after_guess,
        bob_move.move_bytes_node,
        validator.hash,
        0,
    );
    advance_validator_cursor(&mut allocator, &setup, &mut validator, &after_guess);
    assert_eq!(validator.max_move_size, 21);

    let alice_reveal_entropy = make_entropy(&mut allocator, "alice_reveal");
    let alice_reveal = call_my_turn_handler(
        &mut allocator,
        alice_receive.my_turn_handler,
        NodePtr::NIL,
        AMOUNT,
        state_after_guess,
        0,
        alice_reveal_entropy,
    );
    assert_eq!(alice_reveal.new_mover_share, AMOUNT);
    validate_terminal_move(&mut allocator, validator, state_after_guess, &alice_reveal);
}

fn test_krunk_premature_reveal_has_correct_guess_readable() {
    let mut allocator = AllocEncoder::new();
    let setup = setup_game(&mut allocator, test_dictionary());
    let entropy = make_entropy(&mut allocator, "concession_salt");
    let alice_word = atom(&mut allocator, b"world");
    let mut validator = initial_validator_cursor(&mut allocator, &setup);
    let alice_commit = call_my_turn_handler(
        &mut allocator,
        setup.alice_handler,
        alice_word,
        AMOUNT,
        setup.initial_state,
        0,
        entropy,
    );
    let after_commit = run_validator(
        &mut allocator,
        validator.hash,
        alice_commit.move_bytes_node,
        0,
        validator.max_move_size,
        setup.initial_state,
        validator.program,
        NodePtr::NIL,
    );
    let state_after_commit = after_commit.new_state;
    let bob_receive = call_their_turn_handler(
        &mut allocator,
        setup.bob_handler,
        AMOUNT,
        setup.initial_state,
        state_after_commit,
        alice_commit.move_bytes_node,
        validator.hash,
        0,
    );
    advance_validator_cursor(&mut allocator, &setup, &mut validator, &after_commit);

    let correct_word = atom(&mut allocator, b"world");
    let correct_entropy = make_entropy(&mut allocator, "correct_guess");
    let correct_guess = call_my_turn_handler(
        &mut allocator,
        bob_receive.my_turn_handler,
        correct_word,
        AMOUNT,
        state_after_commit,
        0,
        correct_entropy,
    );
    let mut correct_validator = validator;
    let after_correct_guess = run_validator(
        &mut allocator,
        correct_validator.hash,
        correct_guess.move_bytes_node,
        0,
        correct_validator.max_move_size,
        state_after_commit,
        correct_validator.program,
        NodePtr::NIL,
    );
    let correct_guess_state = after_correct_guess.new_state;
    let alice_receive = call_their_turn_handler(
        &mut allocator,
        alice_commit.their_turn_handler,
        AMOUNT,
        state_after_commit,
        correct_guess_state,
        correct_guess.move_bytes_node,
        correct_validator.hash,
        0,
    );
    advance_validator_cursor(
        &mut allocator,
        &setup,
        &mut correct_validator,
        &after_correct_guess,
    );
    let reveal_entropy = make_entropy(&mut allocator, "correct_reveal");
    let reveal = call_my_turn_handler(
        &mut allocator,
        alice_receive.my_turn_handler,
        NodePtr::NIL,
        AMOUNT,
        correct_guess_state,
        0,
        reveal_entropy,
    );
    validate_terminal_move(
        &mut allocator,
        correct_validator,
        correct_guess_state,
        &reveal,
    );
    let normal_readable = call_their_turn_handler(
        &mut allocator,
        correct_guess.their_turn_handler,
        AMOUNT,
        correct_guess_state,
        NodePtr::NIL,
        reveal.move_bytes_node,
        correct_validator.hash,
        reveal.new_mover_share,
    )
    .readable_move;

    let wrong_word = atom(&mut allocator, b"crane");
    let wrong_entropy = make_entropy(&mut allocator, "wrong_guess");
    let wrong_guess = call_my_turn_handler(
        &mut allocator,
        bob_receive.my_turn_handler,
        wrong_word,
        AMOUNT,
        state_after_commit,
        0,
        wrong_entropy,
    );
    let mut wrong_validator = validator;
    let after_wrong_guess = run_validator(
        &mut allocator,
        wrong_validator.hash,
        wrong_guess.move_bytes_node,
        0,
        wrong_validator.max_move_size,
        state_after_commit,
        wrong_validator.program,
        NodePtr::NIL,
    );
    let wrong_guess_state = after_wrong_guess.new_state;
    advance_validator_cursor(
        &mut allocator,
        &setup,
        &mut wrong_validator,
        &after_wrong_guess,
    );
    let concession_readable = call_their_turn_handler(
        &mut allocator,
        wrong_guess.their_turn_handler,
        AMOUNT,
        wrong_guess_state,
        NodePtr::NIL,
        reveal.move_bytes_node,
        wrong_validator.hash,
        reveal.new_mover_share,
    )
    .readable_move;

    assert_clvm_eq(
        &mut allocator,
        normal_readable,
        concession_readable,
        "a funded premature reveal must look exactly like a correct guess",
    );
}

fn test_krunk_bob_invalid_guess_slash() {
    let mut allocator = AllocEncoder::new();
    let setup = setup_game(&mut allocator, test_dictionary());

    let alice_word = atom(&mut allocator, b"crane");
    let bad_guess = atom(&mut allocator, b"xyzzy");
    let entropy = make_entropy(&mut allocator, "alice_salt_seed2");
    let validator = initial_validator_cursor(&mut allocator, &setup);

    let alice_commit = call_my_turn_handler(
        &mut allocator,
        setup.alice_handler,
        alice_word,
        AMOUNT,
        setup.initial_state,
        0,
        entropy,
    );
    let val_result = run_validator(
        &mut allocator,
        validator.hash,
        alice_commit.move_bytes_node,
        0,
        32,
        setup.initial_state,
        validator.program,
        NodePtr::NIL,
    );
    let state = val_result.new_state;

    let guess_validator =
        read_hex_puzzle(&mut allocator, "games/krunk/clsp/onchain/guess.hex").unwrap();
    let guess_hash = validator_hash_node(&mut allocator, &guess_validator);

    // Alice processes an invalid on-chain guess (Bob cheated past handler checks)
    let alice_their = call_their_turn_handler(
        &mut allocator,
        alice_commit.their_turn_handler,
        AMOUNT,
        state,
        state,
        bad_guess,
        guess_hash,
        0,
    );

    let evidence_items =
        proper_list(allocator.allocator(), alice_their.evidence_list, true).unwrap();
    assert!(
        !evidence_items.is_empty(),
        "handler should produce evidence for invalid guess"
    );
    let signed_evidence = Evidence::from_nodeptr(&mut allocator, evidence_items[0]).unwrap();
    assert!(
        signed_evidence.signature().is_some(),
        "dictionary evidence must retain its aggregate signature"
    );
    let evidence = signed_evidence.to_nodeptr(&mut allocator).unwrap();

    let guess_clvm = guess_validator.to_clvm(&mut allocator).unwrap();

    // With range evidence, the validator returns a 4-element list (conditional slash)
    let result = run_validator(
        &mut allocator,
        guess_hash,
        bad_guess,
        0,
        5,
        state,
        guess_clvm,
        evidence,
    );
    assert_eq!(
        result.code,
        MoveCode::MakeMove,
        "conditional slash returns non-empty list"
    );
    let items = proper_list(allocator.allocator(), result.output, true).unwrap();
    assert_eq!(
        items.len(),
        4,
        "should have vh + state + mms + AGG_SIG condition"
    );
    let condition = proper_list(allocator.allocator(), items[3], true).unwrap();
    assert_eq!(
        int_from_node(&mut allocator, condition[0]),
        49,
        "AGG_SIG_UNSAFE code"
    );
}

fn test_krunk_bob_invalid_guess_slashes_through_referee() {
    let mut allocator = AllocEncoder::new();
    let setup = setup_game(&mut allocator, test_dictionary());
    let validator_programs = setup
        .validators
        .iter()
        .map(|program| {
            Program::from_nodeptr(&allocator, *program)
                .map(Rc::new)
                .expect("validator program")
        })
        .collect::<Vec<_>>();
    let validation_programs =
        ValidationProgramRegistry::new(&mut allocator, &validator_programs)
            .expect("validator registry");
    let start = Rc::new(GameStartInfo {
        amount: Amount::new(setup.proposal_amount as u64),
        game_handler: GameHandler::MyTurnHandler(
            Program::from_nodeptr(&allocator, setup.alice_handler)
                .expect("alice handler")
                .into(),
        ),
        player_a_contribution: Amount::new(setup.proposal_my_contribution as u64),
        player_b_contribution: Amount::new(setup.proposal_their_contribution as u64),
        my_contribution_this_game: Amount::new(setup.proposal_my_contribution as u64),
        their_contribution_this_game: Amount::new(setup.proposal_their_contribution as u64),
        validation_programs,
        initial_state: ProgramRef::new(Rc::new(
            Program::from_nodeptr(&allocator, setup.initial_state).expect("initial state"),
        )),
        initial_move: vec![],
        initial_max_move_size: setup.initial_max_move_size as usize,
        initial_mover_share: Amount::new(setup.initial_mover_share as u64),
        game_id: GameID(1),
        timeout: Timeout::new(15),
    });
    let my_private_key = PrivateKey::from_bytes(&[1; 32]).expect("my private key");
    let their_private_key = PrivateKey::from_bytes(&[2; 32]).expect("their private key");
    let my_identity = ChiaIdentity::new(&mut allocator, my_private_key).expect("my identity");
    let their_identity =
        ChiaIdentity::new(&mut allocator, their_private_key).expect("their identity");
    let their_reward_signature =
        sign_reward_payout(&their_identity.private_key, &my_identity.puzzle_hash);
    let referee_puzzle =
        read_hex_puzzle(&mut allocator, "clsp/referee/onchain/referee.hex").unwrap();
    let referee_puzzle_hash = referee_puzzle.sha256tree(&mut allocator);
    let (referee, _) = Referee::new(
        &mut allocator,
        referee_puzzle,
        referee_puzzle_hash,
        &start,
        my_identity.clone(),
        &their_identity.public_key,
        &their_identity.puzzle_hash,
        &their_reward_signature,
        &my_identity.puzzle_hash,
        1,
        &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
        1,
    )
    .expect("initial referee");

    let word = atom(&mut allocator, b"crane");
    let readable = ReadableMove::from_nodeptr(&allocator, word).expect("readable word");
    let prepared = referee
        .prepare_my_turn_move(
            &mut allocator,
            &readable,
            Hash::from_bytes(sha256_bytes(b"alice_salt_seed2")),
        )
        .expect("prepare Alice commitment");
    let (referee, _) = referee
        .apply_prepared_move(&mut allocator, prepared, 2)
        .expect("apply Alice commitment");

    let (next_referee, result) = referee
        .peer_move_off_chain(&mut allocator, b"xyzzy", Amount::default(), 3)
        .expect("out-of-dictionary guess should produce a slash");
    assert!(next_referee.is_none(), "a successful slash ends the game");
    assert!(
        result.slash.is_some(),
        "signed dictionary evidence should slash before continuation agreement"
    );
}

fn validator_hash_node(allocator: &mut AllocEncoder, puzzle: &Puzzle) -> NodePtr {
    let hash = puzzle.sha256tree(allocator);
    allocator.allocator().new_atom(hash.hash().bytes()).unwrap()
}

fn test_krunk_multi_guess_game() {
    let mut allocator = AllocEncoder::new();
    let setup = setup_game(&mut allocator, test_dictionary());

    let alice_word = atom(&mut allocator, b"world");
    let entropy = make_entropy(&mut allocator, "multi_guess_salt");
    let mut validator = initial_validator_cursor(&mut allocator, &setup);

    // Alice commits
    let alice_commit = call_my_turn_handler(
        &mut allocator,
        setup.alice_handler,
        alice_word,
        AMOUNT,
        setup.initial_state,
        0,
        entropy,
    );
    let val_result = run_validator(
        &mut allocator,
        validator.hash,
        alice_commit.move_bytes_node,
        0,
        32,
        setup.initial_state,
        validator.program,
        NodePtr::NIL,
    );
    let mut state = val_result.new_state;

    // Bob receives commit
    let bob_receive = call_their_turn_handler(
        &mut allocator,
        setup.bob_handler,
        AMOUNT,
        setup.initial_state,
        state,
        alice_commit.move_bytes_node,
        validator.hash,
        0,
    );
    advance_validator_cursor(&mut allocator, &setup, &mut validator, &val_result);

    let mut alice_handler = alice_commit.their_turn_handler;
    let mut bob_handler = bob_receive.my_turn_handler;
    let wrong_guesses: [&[u8; 5]; 3] = [b"crane", b"slate", b"trace"];

    // 3 wrong guesses
    for (i, guess_word) in wrong_guesses.iter().enumerate() {
        let bob_entropy = make_entropy(&mut allocator, &format!("bob_g{i}"));
        let bob_guess_node = atom(&mut allocator, guess_word.as_slice());

        let bob_move = call_my_turn_handler(
            &mut allocator,
            bob_handler,
            bob_guess_node,
            AMOUNT,
            state,
            0,
            bob_entropy,
        );

        let after_guess = run_validator(
            &mut allocator,
            validator.hash,
            bob_move.move_bytes_node,
            0,
            validator.max_move_size,
            state,
            validator.program,
            NodePtr::NIL,
        );
        let new_state = after_guess.new_state;

        let alice_receive = call_their_turn_handler(
            &mut allocator,
            alice_handler,
            AMOUNT,
            state,
            new_state,
            bob_move.move_bytes_node,
            validator.hash,
            0,
        );
        advance_validator_cursor(&mut allocator, &setup, &mut validator, &after_guess);
        if i == 0 {
            let readable =
                proper_list(allocator.allocator(), alice_receive.readable_move, true).unwrap();
            assert_eq!(
                int_list_from_node(&mut allocator, readable[1]),
                vec![0, 1, 0, 0, 0],
                "WORLD vs CRANE clue must stay in letter order"
            );
        }
        state = new_state;

        // Alice gives a clue
        let alice_clue_entropy = make_entropy(&mut allocator, &format!("alice_c{i}"));
        let alice_clue = call_my_turn_handler(
            &mut allocator,
            alice_receive.my_turn_handler,
            NodePtr::NIL,
            AMOUNT,
            state,
            0,
            alice_clue_entropy,
        );

        let after_clue = run_validator(
            &mut allocator,
            validator.hash,
            alice_clue.move_bytes_node,
            0,
            validator.max_move_size,
            state,
            validator.program,
            NodePtr::NIL,
        );
        let clue_state = after_clue.new_state;

        let bob_clue_receive = call_their_turn_handler(
            &mut allocator,
            bob_move.their_turn_handler,
            AMOUNT,
            state,
            clue_state,
            alice_clue.move_bytes_node,
            validator.hash,
            0,
        );
        advance_validator_cursor(&mut allocator, &setup, &mut validator, &after_clue);
        if i == 0 {
            assert_eq!(
                int_list_from_node(&mut allocator, bob_clue_receive.readable_move),
                vec![0, 1, 0, 0, 0],
                "Bob must receive clue values in guess-letter order"
            );
        }
        state = clue_state;
        alice_handler = alice_clue.their_turn_handler;
        bob_handler = bob_clue_receive.my_turn_handler;
    }

    // 4th guess is correct: "world"
    let bob_entropy = make_entropy(&mut allocator, "bob_final");
    let bob_guess_node = atom(&mut allocator, b"world");
    let bob_move = call_my_turn_handler(
        &mut allocator,
        bob_handler,
        bob_guess_node,
        AMOUNT,
        state,
        0,
        bob_entropy,
    );

    let after_guess = run_validator(
        &mut allocator,
        validator.hash,
        bob_move.move_bytes_node,
        0,
        validator.max_move_size,
        state,
        validator.program,
        NodePtr::NIL,
    );
    let new_state = after_guess.new_state;

    let alice_receive = call_their_turn_handler(
        &mut allocator,
        alice_handler,
        AMOUNT,
        state,
        new_state,
        bob_move.move_bytes_node,
        validator.hash,
        0,
    );
    advance_validator_cursor(&mut allocator, &setup, &mut validator, &after_guess);
    state = new_state;

    // Alice reveals (correct guess triggers reveal)
    let alice_reveal_entropy = make_entropy(&mut allocator, "alice_reveal_multi");
    let alice_reveal = call_my_turn_handler(
        &mut allocator,
        alice_receive.my_turn_handler,
        NodePtr::NIL,
        AMOUNT,
        state,
        0,
        alice_reveal_entropy,
    );
    // 4th guess payout: 5% of amount = 5 (from KRUNK_PAYOUTS = (100 100 20 5 1))
    assert_eq!(
        alice_reveal.new_mover_share, 5,
        "4th guess payout = 5% of 100 = 5"
    );
    validate_terminal_move(&mut allocator, validator, state, &alice_reveal);

    // Bob receives the reveal. The framework passes nil state for terminal moves.
    let bob_reveal_receive = call_their_turn_handler(
        &mut allocator,
        bob_move.their_turn_handler,
        AMOUNT,
        state,
        NodePtr::NIL,
        alice_reveal.move_bytes_node,
        validator.hash,
        alice_reveal.new_mover_share,
    );
    let evidence_items = proper_list(
        allocator.allocator(),
        bob_reveal_receive.evidence_list,
        true,
    )
    .unwrap();
    assert_eq!(
        evidence_items.len(),
        5,
        "bob should return all plausible clue evidence indices"
    );
    assert_eq!(
        allocator.allocator().atom(evidence_items[0]).as_ref(),
        &[0x00],
        "clue index zero must be encoded as a one-byte atom, not nil"
    );
}

fn test_krunk_5_wrong_guesses_alice_wins() {
    let mut allocator = AllocEncoder::new();
    let setup = setup_game(&mut allocator, test_dictionary());

    let alice_word = atom(&mut allocator, b"world");
    let entropy = make_entropy(&mut allocator, "five_wrong_salt");
    let mut validator = initial_validator_cursor(&mut allocator, &setup);

    // Alice commits
    let alice_commit = call_my_turn_handler(
        &mut allocator,
        setup.alice_handler,
        alice_word,
        AMOUNT,
        setup.initial_state,
        0,
        entropy,
    );
    let val_result = run_validator(
        &mut allocator,
        validator.hash,
        alice_commit.move_bytes_node,
        0,
        32,
        setup.initial_state,
        validator.program,
        NodePtr::NIL,
    );
    let mut state = val_result.new_state;

    let bob_receive = call_their_turn_handler(
        &mut allocator,
        setup.bob_handler,
        AMOUNT,
        setup.initial_state,
        state,
        alice_commit.move_bytes_node,
        validator.hash,
        0,
    );
    advance_validator_cursor(&mut allocator, &setup, &mut validator, &val_result);

    let mut alice_handler = alice_commit.their_turn_handler;
    let mut bob_handler = bob_receive.my_turn_handler;
    let wrong_guesses: [&[u8; 5]; 5] = [b"crane", b"slate", b"trace", b"zzzzz", b"crane"];

    // 5 wrong guesses
    for (i, guess_word) in wrong_guesses.iter().enumerate() {
        let bob_entropy = make_entropy(&mut allocator, &format!("bob5_g{i}"));
        let bob_guess_node = atom(&mut allocator, guess_word.as_slice());

        let bob_move = call_my_turn_handler(
            &mut allocator,
            bob_handler,
            bob_guess_node,
            AMOUNT,
            state,
            0,
            bob_entropy,
        );

        let after_guess = run_validator(
            &mut allocator,
            validator.hash,
            bob_move.move_bytes_node,
            0,
            validator.max_move_size,
            state,
            validator.program,
            NodePtr::NIL,
        );
        let new_state = after_guess.new_state;

        let alice_receive = call_their_turn_handler(
            &mut allocator,
            alice_handler,
            AMOUNT,
            state,
            new_state,
            bob_move.move_bytes_node,
            validator.hash,
            0,
        );
        advance_validator_cursor(&mut allocator, &setup, &mut validator, &after_guess);
        state = new_state;

        if i < 4 {
            // Alice gives a clue
            let alice_clue_entropy = make_entropy(&mut allocator, &format!("alice5_c{i}"));
            let alice_clue = call_my_turn_handler(
                &mut allocator,
                alice_receive.my_turn_handler,
                NodePtr::NIL,
                AMOUNT,
                state,
                0,
                alice_clue_entropy,
            );

            let after_clue = run_validator(
                &mut allocator,
                validator.hash,
                alice_clue.move_bytes_node,
                0,
                validator.max_move_size,
                state,
                validator.program,
                NodePtr::NIL,
            );
            let clue_state = after_clue.new_state;

            let bob_clue_receive = call_their_turn_handler(
                &mut allocator,
                bob_move.their_turn_handler,
                AMOUNT,
                state,
                clue_state,
                alice_clue.move_bytes_node,
                validator.hash,
                0,
            );
            advance_validator_cursor(&mut allocator, &setup, &mut validator, &after_clue);
            state = clue_state;
            alice_handler = alice_clue.their_turn_handler;
            bob_handler = bob_clue_receive.my_turn_handler;
        } else {
            // 5th wrong guess triggers reveal with mover_share = 0
            let alice_reveal_entropy = make_entropy(&mut allocator, "alice5_reveal");
            let alice_reveal = call_my_turn_handler(
                &mut allocator,
                alice_receive.my_turn_handler,
                NodePtr::NIL,
                AMOUNT,
                state,
                0,
                alice_reveal_entropy,
            );
            assert_eq!(
                alice_reveal.new_mover_share, 0,
                "5 wrong guesses → alice keeps all"
            );
            validate_terminal_move(&mut allocator, validator, state, &alice_reveal);
        }
    }
}

fn test_krunk_bob_detects_wrong_clue() {
    // Verify the end-to-end wrong-clue slash: construct a state where Alice gave
    // a wrong clue, then run the validator with evidence to confirm the slash works.
    // This tests the same path that Bob's evidence indices would trigger on-chain.
    let mut allocator = AllocEncoder::new();

    let clue_validator =
        read_hex_puzzle(&mut allocator, "games/krunk/clsp/onchain/clue.hex").unwrap();

    let word = b"world";
    let salt = [0x77; 16];
    let commit = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(&salt);
        hasher.update(word);
        let h = hasher.finalize();
        let mut c = [0u8; 32];
        c.copy_from_slice(&h);
        c
    };

    let dict_pubkey = allocator.allocator().new_atom(&[0xAA; 48]).unwrap();
    let base_unit_node = (BET_SIZE / 50).to_clvm(&mut allocator).unwrap();

    // Reveal-time state: latest guess has no clue yet, so clues are offset by
    // one from guesses. Wrong clue at evidence index 1 checks "crane".
    let bob_guesses = {
        let latest = allocator.allocator().new_atom(b"world").unwrap();
        let w1 = allocator.allocator().new_atom(b"slate").unwrap();
        let w2 = allocator.allocator().new_atom(b"crane").unwrap();
        let t = allocator.allocator().new_pair(w2, NodePtr::NIL).unwrap();
        let t = allocator.allocator().new_pair(w1, t).unwrap();
        allocator.allocator().new_pair(latest, t).unwrap()
    };
    let wrong_clue = allocator.allocator().new_atom(&[0x01]).unwrap();
    let some_clue = allocator.allocator().new_atom(&[0x42]).unwrap();
    let alice_clues = {
        let a = allocator.allocator();
        let t = a.new_pair(wrong_clue, NodePtr::NIL).unwrap();
        a.new_pair(some_clue, t).unwrap()
    };
    let commit_node = allocator.allocator().new_atom(&commit).unwrap();
    let clue_hash_val = clue_validator.sha256tree(&mut allocator);
    let clue_hash_node = allocator
        .allocator()
        .new_atom(clue_hash_val.hash().bytes())
        .unwrap();
    let state = {
        let a = allocator.allocator();
        let tail = a.new_pair(clue_hash_node, NodePtr::NIL).unwrap();
        let tail = a.new_pair(commit_node, tail).unwrap();
        let tail = a.new_pair(alice_clues, tail).unwrap();
        let tail = a.new_pair(bob_guesses, tail).unwrap();
        let tail = a.new_pair(base_unit_node, tail).unwrap();
        a.new_pair(dict_pubkey, tail).unwrap()
    };

    // Reveal move
    let mut reveal_move = Vec::new();
    reveal_move.extend_from_slice(&salt);
    reveal_move.extend_from_slice(word);

    // Run validator with evidence=1 → checks make_clue("world","crane") vs alice_clues[1]=0x01
    let evidence = allocator.allocator().new_atom(&[0x01]).unwrap();

    let clue_clvm = clue_validator.to_clvm(&mut allocator).unwrap();
    let move_node = allocator.allocator().new_atom(&reveal_move).unwrap();
    let amount_node = AMOUNT.to_clvm(&mut allocator).unwrap();
    let mms_node = 21_i64.to_clvm(&mut allocator).unwrap();
    let ms_node = 0_i64.to_clvm(&mut allocator).unwrap();
    let curry_args = {
        let a = allocator.allocator();
        let tail = a.new_pair(NodePtr::NIL, NodePtr::NIL).unwrap();
        let tail = a.new_pair(ms_node, tail).unwrap();
        let tail = a.new_pair(NodePtr::NIL, tail).unwrap();
        let tail = a.new_pair(mms_node, tail).unwrap();
        let tail = a.new_pair(move_node, tail).unwrap();
        let tail = a.new_pair(NodePtr::NIL, tail).unwrap();
        let tail = a.new_pair(NodePtr::NIL, tail).unwrap();
        let tail = a.new_pair(amount_node, tail).unwrap();
        let tail = a.new_pair(NodePtr::NIL, tail).unwrap();
        let tail = a.new_pair(NodePtr::NIL, tail).unwrap();
        a.new_pair(NodePtr::NIL, tail).unwrap()
    };
    let args = {
        let a = allocator.allocator();
        let tail = a.new_pair(NodePtr::NIL, NodePtr::NIL).unwrap();
        let tail = a.new_pair(evidence, tail).unwrap();
        let tail = a.new_pair(clue_clvm, tail).unwrap();
        let tail = a.new_pair(state, tail).unwrap();
        let tail = a.new_pair(curry_args, tail).unwrap();
        a.new_pair(clue_hash_node, tail).unwrap()
    };

    let result = run_clvm(&mut allocator, clue_clvm, args);
    let items = proper_list(allocator.allocator(), result, true).unwrap();
    assert!(
        items.is_empty(),
        "wrong clue at index 1 should produce unconditional slash (nil)"
    );
}

fn play_game_to_depth(depth: usize) -> i64 {
    let mut allocator = AllocEncoder::new();
    let setup = setup_game(&mut allocator, test_dictionary());

    let alice_word = atom(&mut allocator, b"world");
    let entropy = make_entropy(&mut allocator, &format!("depth_{depth}_salt"));
    let mut validator = initial_validator_cursor(&mut allocator, &setup);

    let alice_commit = call_my_turn_handler(
        &mut allocator,
        setup.alice_handler,
        alice_word,
        AMOUNT,
        setup.initial_state,
        0,
        entropy,
    );
    let val_result = run_validator(
        &mut allocator,
        validator.hash,
        alice_commit.move_bytes_node,
        0,
        32,
        setup.initial_state,
        validator.program,
        NodePtr::NIL,
    );
    let mut state = val_result.new_state;

    let bob_receive = call_their_turn_handler(
        &mut allocator,
        setup.bob_handler,
        AMOUNT,
        setup.initial_state,
        state,
        alice_commit.move_bytes_node,
        validator.hash,
        0,
    );
    advance_validator_cursor(&mut allocator, &setup, &mut validator, &val_result);

    let mut alice_handler = alice_commit.their_turn_handler;
    let mut bob_handler = bob_receive.my_turn_handler;
    let wrong_guesses: [&[u8; 5]; 4] = [b"crane", b"slate", b"trace", b"zzzzz"];

    for i in 0..depth {
        let guess_word = if i == depth - 1 {
            b"world"
        } else {
            wrong_guesses[i]
        };
        let bob_entropy = make_entropy(&mut allocator, &format!("depth{depth}_bob_g{i}"));
        let bob_guess_node = atom(&mut allocator, guess_word);

        let bob_move = call_my_turn_handler(
            &mut allocator,
            bob_handler,
            bob_guess_node,
            AMOUNT,
            state,
            0,
            bob_entropy,
        );
        let after_guess = run_validator(
            &mut allocator,
            validator.hash,
            bob_move.move_bytes_node,
            0,
            validator.max_move_size,
            state,
            validator.program,
            NodePtr::NIL,
        );
        let new_state = after_guess.new_state;

        let alice_receive = call_their_turn_handler(
            &mut allocator,
            alice_handler,
            AMOUNT,
            state,
            new_state,
            bob_move.move_bytes_node,
            validator.hash,
            0,
        );
        advance_validator_cursor(&mut allocator, &setup, &mut validator, &after_guess);
        state = new_state;

        if i < depth - 1 {
            // Not the last guess — Alice gives clue
            let alice_clue_entropy = make_entropy(&mut allocator, &format!("depth{depth}_ac{i}"));
            let alice_clue = call_my_turn_handler(
                &mut allocator,
                alice_receive.my_turn_handler,
                NodePtr::NIL,
                AMOUNT,
                state,
                0,
                alice_clue_entropy,
            );
            let after_clue = run_validator(
                &mut allocator,
                validator.hash,
                alice_clue.move_bytes_node,
                0,
                validator.max_move_size,
                state,
                validator.program,
                NodePtr::NIL,
            );
            let clue_state = after_clue.new_state;
            let bob_clue_receive = call_their_turn_handler(
                &mut allocator,
                bob_move.their_turn_handler,
                AMOUNT,
                state,
                clue_state,
                alice_clue.move_bytes_node,
                validator.hash,
                0,
            );
            advance_validator_cursor(&mut allocator, &setup, &mut validator, &after_clue);
            state = clue_state;
            alice_handler = alice_clue.their_turn_handler;
            bob_handler = bob_clue_receive.my_turn_handler;
        } else {
            // Correct guess triggers reveal
            let alice_reveal_entropy =
                make_entropy(&mut allocator, &format!("depth{depth}_reveal"));
            let alice_reveal = call_my_turn_handler(
                &mut allocator,
                alice_receive.my_turn_handler,
                NodePtr::NIL,
                AMOUNT,
                state,
                0,
                alice_reveal_entropy,
            );
            validate_terminal_move(&mut allocator, validator, state, &alice_reveal);
            return alice_reveal.new_mover_share;
        }
    }
    unreachable!()
}

fn test_krunk_reveal_payout_at_each_depth() {
    // KRUNK_PAYOUTS = (100 100 20 5 1), base_unit = 1
    let expected: [(usize, i64); 5] = [(1, 100), (2, 100), (3, 20), (4, 5), (5, 1)];
    for (depth, expected_payout) in expected {
        let actual = play_game_to_depth(depth);
        assert_eq!(
            actual, expected_payout,
            "depth {depth}: expected payout {expected_payout}, got {actual}"
        );
    }
}

pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
    vec![
        ("test_krunk_setup_game", &test_krunk_setup_game),
        (
            "test_krunk_guesser_funds_zero",
            &test_krunk_guesser_funds_zero,
        ),
        (
            "test_krunk_rejects_malformed_economics",
            &test_krunk_rejects_malformed_economics,
        ),
        (
            "test_krunk_invalid_words_are_typed_rejections",
            &test_krunk_invalid_words_are_typed_rejections,
        ),
        (
            "test_krunk_happy_path_correct_guess",
            &test_krunk_happy_path_correct_guess,
        ),
        (
            "test_krunk_premature_reveal_has_correct_guess_readable",
            &test_krunk_premature_reveal_has_correct_guess_readable,
        ),
        (
            "test_krunk_bob_invalid_guess_slash",
            &test_krunk_bob_invalid_guess_slash,
        ),
        (
            "test_krunk_bob_invalid_guess_slashes_through_referee",
            &test_krunk_bob_invalid_guess_slashes_through_referee,
        ),
        ("test_krunk_multi_guess_game", &test_krunk_multi_guess_game),
        (
            "test_krunk_5_wrong_guesses_alice_wins",
            &test_krunk_5_wrong_guesses_alice_wins,
        ),
        (
            "test_krunk_bob_detects_wrong_clue",
            &test_krunk_bob_detects_wrong_clue,
        ),
        (
            "test_krunk_reveal_payout_at_each_depth",
            &test_krunk_reveal_payout_at_each_depth,
        ),
    ]
}
