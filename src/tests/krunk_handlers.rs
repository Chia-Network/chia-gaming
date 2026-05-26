#![allow(non_snake_case)]

use crate::common::load_clvm::read_hex_puzzle;
use crate::common::types::{chia_dialect, AllocEncoder, Puzzle, Sha256Input, Sha256tree};
use crate::utils::proper_list;

use clvm_traits::ToClvm;
use clvmr::allocator::{NodePtr, SExp};
use clvmr::run_program;

const BET_SIZE: i64 = 100;
const AMOUNT: i64 = 2 * BET_SIZE;

fn sha256_bytes(data: &[u8]) -> [u8; 32] {
    *Sha256Input::Bytes(data).hash().bytes()
}

fn sha256_concat(a: &[u8], b: &[u8]) -> [u8; 32] {
    *Sha256Input::Array(vec![Sha256Input::Bytes(a), Sha256Input::Bytes(b)])
        .hash()
        .bytes()
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

fn atom(allocator: &mut AllocEncoder, bytes: &[u8]) -> NodePtr {
    allocator.allocator().new_atom(bytes).unwrap()
}

fn words_to_list(allocator: &mut AllocEncoder, words: &[&str]) -> NodePtr {
    let mut tail = NodePtr::NIL;
    for word in words.iter().rev() {
        tail = allocator
            .allocator()
            .new_pair(atom(allocator, word.as_bytes()), tail)
            .unwrap();
    }
    tail
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

struct MyTurnResult {
    move_bytes_node: NodePtr,
    validator_for_my_move: NodePtr,
    validator_for_my_move_hash: NodePtr,
    validator_for_their_next_move: NodePtr,
    validator_for_their_move_hash: NodePtr,
    max_move_size: i64,
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
    assert!(items.len() >= 8, "my_turn returned {} items", items.len());

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
    assert!(items.len() >= 2, "their_turn returned {} items", items.len());

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
    dictionary: NodePtr,
    alice_handler: NodePtr,
    alice_validator: NodePtr,
    bob_handler: NodePtr,
    bob_validator: NodePtr,
    initial_validator_hash: NodePtr,
    initial_state: NodePtr,
    initial_max_move_size: i64,
    initial_mover_share: i64,
}

fn setup_game(allocator: &mut AllocEncoder, dictionary: NodePtr) -> GameSetup {
    let make_proposal = read_hex_puzzle(
        allocator,
        "clsp/games/krunk/krunk_include_krunk_make_proposal.hex",
    )
    .expect("load make_proposal");
    let parser = read_hex_puzzle(
        allocator,
        "clsp/games/krunk/krunk_include_krunk_parser.hex",
    )
    .expect("load parser");

    let make_proposal_clvm = make_proposal.to_clvm(allocator).unwrap();
    let parser_clvm = parser.to_clvm(allocator).unwrap();

    let bet_args = (BET_SIZE, dictionary).to_clvm(allocator).unwrap();
    let proposal_result = run_clvm(allocator, make_proposal_clvm, bet_args);
    let proposal_list = proper_list(allocator.allocator(), proposal_result, true).unwrap();
    let wire_data = proposal_list[0];
    let local_data = proposal_list[1];

    let wire_data_list = proper_list(allocator.allocator(), wire_data, true).unwrap();
    let game_specs_wrapper = proper_list(allocator.allocator(), wire_data_list[2], true).unwrap();
    let game_spec = proper_list(allocator.allocator(), game_specs_wrapper[0], true).unwrap();
    let initial_validator_hash = game_spec[2];
    let initial_max_move_size = int_from_node(allocator, game_spec[4]);
    let initial_state = game_spec[5];
    let initial_mover_share = int_from_node(allocator, game_spec[6]);

    let local_data_list = proper_list(allocator.allocator(), local_data, true).unwrap();
    let hv_list = proper_list(allocator.allocator(), local_data_list[0], true).unwrap();
    let alice_handler = hv_list[0];
    let alice_validator = hv_list[1];

    let parser_result = run_clvm(allocator, parser_clvm, wire_data);
    let parser_list = proper_list(allocator.allocator(), parser_result, true).unwrap();
    let bob_data_list = proper_list(allocator.allocator(), parser_list[1], true).unwrap();
    let bob_hv_list = proper_list(allocator.allocator(), bob_data_list[0], true).unwrap();
    let bob_validator = bob_hv_list[0];
    let bob_handler = bob_hv_list[1];

    GameSetup {
        dictionary,
        alice_handler,
        alice_validator,
        bob_handler,
        bob_validator,
        initial_validator_hash,
        initial_state,
        initial_max_move_size,
        initial_mover_share,
    }
}

fn make_entropy(allocator: &mut AllocEncoder, seed: &str) -> NodePtr {
    atom(allocator, &sha256_bytes(seed.as_bytes()))
}

fn test_dictionary() -> Vec<&'static str> {
    vec!["crane", "slate", "trace", "world", "zzzzz"]
}

fn test_krunk_setup_game() {
    let mut allocator = AllocEncoder::new();
    let dictionary = words_to_list(&mut allocator, &test_dictionary());
    let setup = setup_game(&mut allocator, dictionary);
    assert_eq!(setup.initial_max_move_size, 32);
    assert_eq!(setup.initial_mover_share, 0);
}

fn test_krunk_happy_path_correct_guess() {
    let mut allocator = AllocEncoder::new();
    let dictionary = words_to_list(&mut allocator, &test_dictionary());
    let setup = setup_game(&mut allocator, dictionary);

    let alice_word = atom(&mut allocator, b"crane");
    let bob_guess = atom(&mut allocator, b"crane");
    let entropy = make_entropy(&mut allocator, "alice_salt_seed");

    // Alice commits to "crane"
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

    let (_, val_result) = run_validator(
        &mut allocator,
        alice_commit.validator_for_my_move_hash,
        alice_commit.move_bytes_node,
        0,
        alice_commit.max_move_size,
        setup.initial_state,
        alice_commit.validator_for_my_move,
        NodePtr::NIL,
    );
    let val_items = proper_list(allocator.allocator(), val_result, true).unwrap();
    let state_after_commit = val_items[1];

    // Bob receives commit
    let bob_receive = call_their_turn_handler(
        &mut allocator,
        setup.bob_handler,
        AMOUNT,
        setup.initial_state,
        state_after_commit,
        alice_commit.move_bytes_node,
        alice_commit.validator_for_my_move_hash,
        0,
    );

    // Bob guesses correctly on first try
    let bob_move = call_my_turn_handler(
        &mut allocator,
        bob_receive.my_turn_handler,
        bob_guess,
        AMOUNT,
        state_after_commit,
        0,
        make_entropy(&mut allocator, "bob_entropy"),
    );
    assert_eq!(bob_move.max_move_size, 21);

    let (_, after_guess) = run_validator(
        &mut allocator,
        bob_move.validator_for_my_move_hash,
        bob_move.move_bytes_node,
        0,
        bob_move.max_move_size,
        state_after_commit,
        bob_move.validator_for_my_move,
        NodePtr::NIL,
    );
    let guess_items = proper_list(allocator.allocator(), after_guess, true).unwrap();
    let state_after_guess = guess_items[1];

    // Alice processes Bob's correct guess
    let alice_receive = call_their_turn_handler(
        &mut allocator,
        alice_commit.their_turn_handler,
        AMOUNT,
        state_after_commit,
        state_after_guess,
        bob_move.move_bytes_node,
        bob_move.validator_for_my_move_hash,
        0,
    );

    // Alice reveals (terminal)
    let alice_reveal = call_my_turn_handler(
        &mut allocator,
        alice_receive.my_turn_handler,
        NodePtr::NIL,
        AMOUNT,
        state_after_guess,
        0,
        make_entropy(&mut allocator, "alice_reveal"),
    );
    assert_eq!(alice_reveal.new_mover_share, AMOUNT);
}

fn test_krunk_bob_invalid_guess_slash() {
    let mut allocator = AllocEncoder::new();
    let dictionary = words_to_list(&mut allocator, &test_dictionary());
    let setup = setup_game(&mut allocator, dictionary);

    let alice_word = atom(&mut allocator, b"crane");
    let bad_guess = atom(&mut allocator, b"xyzzy");
    let entropy = make_entropy(&mut allocator, "alice_salt_seed2");

    let alice_commit = call_my_turn_handler(
        &mut allocator,
        setup.alice_handler,
        alice_word,
        AMOUNT,
        setup.initial_state,
        0,
        entropy,
    );
    let (_, val_result) = run_validator(
        &mut allocator,
        alice_commit.validator_for_my_move_hash,
        alice_commit.move_bytes_node,
        0,
        32,
        setup.initial_state,
        alice_commit.validator_for_my_move,
        NodePtr::NIL,
    );
    let state = proper_list(allocator.allocator(), val_result, true).unwrap()[1];

    let guess_validator =
        read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/guess.hex").unwrap();
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
    assert!(!evidence_items.is_empty());

    let guess_clvm = guess_validator.to_clvm(&mut allocator).unwrap();

    let (code, _) = run_validator(
        &mut allocator,
        guess_hash,
        bad_guess,
        0,
        5,
        state,
        guess_clvm,
        evidence_items[0],
    );
    assert_eq!(code, MoveCode::Slash);
}

fn validator_hash_node(allocator: &mut AllocEncoder, puzzle: &Puzzle) -> NodePtr {
    let hash = puzzle.sha256tree(allocator);
    allocator
        .allocator()
        .new_atom(hash.hash().bytes())
        .unwrap()
}

pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
    vec![
        ("test_krunk_setup_game", &test_krunk_setup_game),
        (
            "test_krunk_happy_path_correct_guess",
            &test_krunk_happy_path_correct_guess,
        ),
        (
            "test_krunk_bob_invalid_guess_slash",
            &test_krunk_bob_invalid_guess_slash,
        ),
    ]
}
