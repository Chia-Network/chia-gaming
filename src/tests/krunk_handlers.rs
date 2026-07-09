#![allow(non_snake_case)]

use crate::common::load_clvm::read_hex_puzzle;
use crate::common::types::{chia_dialect, Aggsig, AllocEncoder, Puzzle, Sha256Input, Sha256tree};
use crate::games::krunk_dict_tree::build_signed_dict_tree_from_bytes;
use crate::utils::proper_list;

use chia_protocol::Bytes;
use clvm_traits::{clvm_curried_args, ToClvm};
use clvm_utils::CurriedProgram;
use clvmr::allocator::{NodePtr, SExp};
use clvmr::run_program;

const BET_SIZE: i64 = 100;
const AMOUNT: i64 = 2 * BET_SIZE;

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

fn atom(allocator: &mut AllocEncoder, bytes: &[u8]) -> NodePtr {
    allocator.allocator().new_atom(bytes).unwrap()
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
    #[allow(dead_code)]
    validator_for_their_next_move: NodePtr,
    #[allow(dead_code)]
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
    #[allow(dead_code)]
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
    alice_handler: NodePtr,
    bob_handler: NodePtr,
    initial_state: NodePtr,
    initial_max_move_size: i64,
    initial_mover_share: i64,
}

/// Sets up a krunk game by building a dict tree from the supplied dictionary,
/// currying it with a placeholder dict_pubkey into the proposal/parser puzzles,
/// then running them to extract the initial state, handlers, and validators.
fn setup_game(allocator: &mut AllocEncoder, dictionary: Vec<Bytes>) -> GameSetup {
    let make_proposal_raw = read_hex_puzzle(
        allocator,
        "clsp/games/krunk/krunk_include_krunk_make_proposal.hex",
    )
    .expect("load make_proposal");
    let parser_raw = read_hex_puzzle(
        allocator,
        "clsp/games/krunk/krunk_include_krunk_parser.hex",
    )
    .expect("load parser");

    let n_words = dictionary.len();
    let sigs: Vec<Aggsig> = (0..=n_words).map(|_| Aggsig::default()).collect();
    let dict_tree =
        build_signed_dict_tree_from_bytes(allocator, &dictionary, &sigs).expect("build dict tree");
    let make_proposal_curried = CurriedProgram {
        program: make_proposal_raw,
        args: clvm_curried_args!(dict_tree),
    }
    .to_clvm(allocator)
    .unwrap();
    let parser_curried = CurriedProgram {
        program: parser_raw,
        args: clvm_curried_args!(dict_tree),
    }
    .to_clvm(allocator)
    .unwrap();

    let bet_args = (BET_SIZE, ()).to_clvm(allocator).unwrap();
    let proposal_result = run_clvm(allocator, make_proposal_curried, bet_args);
    let proposal_list = proper_list(allocator.allocator(), proposal_result, true).unwrap();
    let wire_data = proposal_list[0];
    let local_data = proposal_list[1];

    let wire_data_list = proper_list(allocator.allocator(), wire_data, true).unwrap();
    let game_specs_wrapper = proper_list(allocator.allocator(), wire_data_list[2], true).unwrap();
    let game_spec = proper_list(allocator.allocator(), game_specs_wrapper[0], true).unwrap();
    let initial_max_move_size = int_from_node(allocator, game_spec[4]);
    let initial_state = game_spec[5];
    let initial_mover_share = int_from_node(allocator, game_spec[6]);

    let local_data_list = proper_list(allocator.allocator(), local_data, true).unwrap();
    let hv_list = proper_list(allocator.allocator(), local_data_list[0], true).unwrap();
    let alice_handler = hv_list[0];

    let parser_result = run_clvm(allocator, parser_curried, wire_data);
    let parser_list = proper_list(allocator.allocator(), parser_result, true).unwrap();
    let bob_data_list = proper_list(allocator.allocator(), parser_list[1], true).unwrap();
    let bob_hv_list = proper_list(allocator.allocator(), bob_data_list[0], true).unwrap();
    let bob_handler = bob_hv_list[1];

    GameSetup {
        alice_handler,
        bob_handler,
        initial_state,
        initial_max_move_size,
        initial_mover_share,
    }
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

fn test_krunk_setup_game() {
    let mut allocator = AllocEncoder::new();
    let setup = setup_game(&mut allocator, test_dictionary());
    assert_eq!(setup.initial_max_move_size, 32);
    assert_eq!(setup.initial_mover_share, 0);
}

fn test_krunk_happy_path_correct_guess() {
    let mut allocator = AllocEncoder::new();
    let setup = setup_game(&mut allocator, test_dictionary());

    let alice_word = atom(&mut allocator, b"crane");
    let bob_guess = atom(&mut allocator, b"crane");
    let entropy = make_entropy(&mut allocator, "alice_salt_seed");

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
}

fn test_krunk_bob_invalid_guess_slash() {
    let mut allocator = AllocEncoder::new();
    let setup = setup_game(&mut allocator, test_dictionary());

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
    assert!(!evidence_items.is_empty(), "handler should produce evidence for invalid guess");

    let guess_clvm = guess_validator.to_clvm(&mut allocator).unwrap();

    // With range evidence, the validator returns a 4-element list (conditional slash)
    let (code, result) = run_validator(
        &mut allocator,
        guess_hash,
        bad_guess,
        0,
        5,
        state,
        guess_clvm,
        evidence_items[0],
    );
    assert_eq!(code, MoveCode::MakeMove, "conditional slash returns non-empty list");
    let items = proper_list(allocator.allocator(), result, true).unwrap();
    assert_eq!(items.len(), 4, "should have vh + state + mms + AGG_SIG condition");
    let condition = proper_list(allocator.allocator(), items[3], true).unwrap();
    assert_eq!(int_from_node(&mut allocator, condition[0]), 49, "AGG_SIG_UNSAFE code");
}

fn validator_hash_node(allocator: &mut AllocEncoder, puzzle: &Puzzle) -> NodePtr {
    let hash = puzzle.sha256tree(allocator);
    allocator
        .allocator()
        .new_atom(hash.hash().bytes())
        .unwrap()
}

fn test_krunk_multi_guess_game() {
    let mut allocator = AllocEncoder::new();
    let setup = setup_game(&mut allocator, test_dictionary());

    let alice_word = atom(&mut allocator, b"world");
    let entropy = make_entropy(&mut allocator, "multi_guess_salt");

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
    let mut state = proper_list(allocator.allocator(), val_result, true).unwrap()[1];

    // Bob receives commit
    let bob_receive = call_their_turn_handler(
        &mut allocator,
        setup.bob_handler,
        AMOUNT,
        setup.initial_state,
        state,
        alice_commit.move_bytes_node,
        alice_commit.validator_for_my_move_hash,
        0,
    );

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

        let (_, after_guess) = run_validator(
            &mut allocator,
            bob_move.validator_for_my_move_hash,
            bob_move.move_bytes_node,
            0,
            bob_move.max_move_size,
            state,
            bob_move.validator_for_my_move,
            NodePtr::NIL,
        );
        let new_state = proper_list(allocator.allocator(), after_guess, true).unwrap()[1];

        let alice_receive = call_their_turn_handler(
            &mut allocator,
            alice_handler,
            AMOUNT,
            state,
            new_state,
            bob_move.move_bytes_node,
            bob_move.validator_for_my_move_hash,
            0,
        );
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

        let (_, after_clue) = run_validator(
            &mut allocator,
            alice_clue.validator_for_my_move_hash,
            alice_clue.move_bytes_node,
            0,
            alice_clue.max_move_size,
            state,
            alice_clue.validator_for_my_move,
            NodePtr::NIL,
        );
        let clue_state = proper_list(allocator.allocator(), after_clue, true).unwrap()[1];

        let bob_clue_receive = call_their_turn_handler(
            &mut allocator,
            bob_move.their_turn_handler,
            AMOUNT,
            state,
            clue_state,
            alice_clue.move_bytes_node,
            alice_clue.validator_for_my_move_hash,
            0,
        );
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

    let (_, after_guess) = run_validator(
        &mut allocator,
        bob_move.validator_for_my_move_hash,
        bob_move.move_bytes_node,
        0,
        bob_move.max_move_size,
        state,
        bob_move.validator_for_my_move,
        NodePtr::NIL,
    );
    let new_state = proper_list(allocator.allocator(), after_guess, true).unwrap()[1];

    let alice_receive = call_their_turn_handler(
        &mut allocator,
        alice_handler,
        AMOUNT,
        state,
        new_state,
        bob_move.move_bytes_node,
        bob_move.validator_for_my_move_hash,
        0,
    );
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
    // 4th guess payout: 5% of amount = 10 (from KRUNK_PAYOUTS = (100 100 20 5 1))
    assert_eq!(alice_reveal.new_mover_share, 10, "4th guess payout = 5% of 200 = 10");

    // Bob receives the reveal. The framework passes nil state for terminal moves.
    let _bob_reveal_receive = call_their_turn_handler(
        &mut allocator,
        bob_move.their_turn_handler,
        AMOUNT,
        state,
        NodePtr::NIL,
        alice_reveal.move_bytes_node,
        alice_reveal.validator_for_my_move_hash,
        alice_reveal.new_mover_share,
    );
}

fn test_krunk_5_wrong_guesses_alice_wins() {
    let mut allocator = AllocEncoder::new();
    let setup = setup_game(&mut allocator, test_dictionary());

    let alice_word = atom(&mut allocator, b"world");
    let entropy = make_entropy(&mut allocator, "five_wrong_salt");

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
    let mut state = proper_list(allocator.allocator(), val_result, true).unwrap()[1];

    let bob_receive = call_their_turn_handler(
        &mut allocator,
        setup.bob_handler,
        AMOUNT,
        setup.initial_state,
        state,
        alice_commit.move_bytes_node,
        alice_commit.validator_for_my_move_hash,
        0,
    );

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

        let (_, after_guess) = run_validator(
            &mut allocator,
            bob_move.validator_for_my_move_hash,
            bob_move.move_bytes_node,
            0,
            bob_move.max_move_size,
            state,
            bob_move.validator_for_my_move,
            NodePtr::NIL,
        );
        let new_state = proper_list(allocator.allocator(), after_guess, true).unwrap()[1];

        let alice_receive = call_their_turn_handler(
            &mut allocator,
            alice_handler,
            AMOUNT,
            state,
            new_state,
            bob_move.move_bytes_node,
            bob_move.validator_for_my_move_hash,
            0,
        );
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

            let (_, after_clue) = run_validator(
                &mut allocator,
                alice_clue.validator_for_my_move_hash,
                alice_clue.move_bytes_node,
                0,
                alice_clue.max_move_size,
                state,
                alice_clue.validator_for_my_move,
                NodePtr::NIL,
            );
            let clue_state = proper_list(allocator.allocator(), after_clue, true).unwrap()[1];

            let bob_clue_receive = call_their_turn_handler(
                &mut allocator,
                bob_move.their_turn_handler,
                AMOUNT,
                state,
                clue_state,
                alice_clue.move_bytes_node,
                alice_clue.validator_for_my_move_hash,
                0,
            );
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
            assert_eq!(alice_reveal.new_mover_share, 0, "5 wrong guesses → alice keeps all");
        }
    }
}

fn test_krunk_bob_detects_wrong_clue() {
    // Verify the end-to-end wrong-clue slash: construct a state where Alice gave
    // a wrong clue, then run the validator with evidence to confirm the slash works.
    // This tests the same path that Bob's evidence indices would trigger on-chain.
    let mut allocator = AllocEncoder::new();

    let clue_validator = read_hex_puzzle(
        &mut allocator,
        "clsp/games/krunk/onchain/clue.hex",
    ).unwrap();

    let word = b"world";
    let salt = [0x77; 16];
    let commit = {
        use sha2::{Sha256, Digest};
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

    // 2 guesses: ["slate", "crane"] (latest first). Wrong clue at index 1.
    let bob_guesses = {
        let w1 = allocator.allocator().new_atom(b"slate").unwrap();
        let w2 = allocator.allocator().new_atom(b"crane").unwrap();
        let t = allocator.allocator().new_pair(w2, NodePtr::NIL).unwrap();
        allocator.allocator().new_pair(w1, t).unwrap()
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
    let clue_hash_node = allocator.allocator().new_atom(clue_hash_val.hash().bytes()).unwrap();
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
    assert!(items.is_empty(), "wrong clue at index 1 should produce unconditional slash (nil)");
}

fn play_game_to_depth(depth: usize) -> i64 {
    let mut allocator = AllocEncoder::new();
    let setup = setup_game(&mut allocator, test_dictionary());

    let alice_word = atom(&mut allocator, b"world");
    let entropy = make_entropy(&mut allocator, &format!("depth_{depth}_salt"));

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
    let mut state = proper_list(allocator.allocator(), val_result, true).unwrap()[1];

    let bob_receive = call_their_turn_handler(
        &mut allocator,
        setup.bob_handler,
        AMOUNT,
        setup.initial_state,
        state,
        alice_commit.move_bytes_node,
        alice_commit.validator_for_my_move_hash,
        0,
    );

    let mut alice_handler = alice_commit.their_turn_handler;
    let mut bob_handler = bob_receive.my_turn_handler;
    let wrong_guesses: [&[u8; 5]; 4] = [b"crane", b"slate", b"trace", b"zzzzz"];

    for i in 0..depth {
        let guess_word = if i == depth - 1 { b"world" } else { wrong_guesses[i] };
        let bob_entropy = make_entropy(&mut allocator, &format!("depth{depth}_bob_g{i}"));
        let bob_guess_node = atom(&mut allocator, guess_word);

        let bob_move = call_my_turn_handler(
            &mut allocator, bob_handler, bob_guess_node, AMOUNT, state, 0, bob_entropy,
        );
        let (_, after_guess) = run_validator(
            &mut allocator, bob_move.validator_for_my_move_hash,
            bob_move.move_bytes_node, 0, bob_move.max_move_size, state,
            bob_move.validator_for_my_move, NodePtr::NIL,
        );
        let new_state = proper_list(allocator.allocator(), after_guess, true).unwrap()[1];

        let alice_receive = call_their_turn_handler(
            &mut allocator, alice_handler, AMOUNT, state, new_state,
            bob_move.move_bytes_node, bob_move.validator_for_my_move_hash, 0,
        );
        state = new_state;

        if i < depth - 1 {
            // Not the last guess — Alice gives clue
            let alice_clue_entropy = make_entropy(&mut allocator, &format!("depth{depth}_ac{i}"));
            let alice_clue = call_my_turn_handler(
                &mut allocator, alice_receive.my_turn_handler, NodePtr::NIL,
                AMOUNT, state, 0, alice_clue_entropy,
            );
            let (_, after_clue) = run_validator(
                &mut allocator, alice_clue.validator_for_my_move_hash,
                alice_clue.move_bytes_node, 0, alice_clue.max_move_size, state,
                alice_clue.validator_for_my_move, NodePtr::NIL,
            );
            let clue_state = proper_list(allocator.allocator(), after_clue, true).unwrap()[1];
            let bob_clue_receive = call_their_turn_handler(
                &mut allocator, bob_move.their_turn_handler, AMOUNT, state, clue_state,
                alice_clue.move_bytes_node, alice_clue.validator_for_my_move_hash, 0,
            );
            state = clue_state;
            alice_handler = alice_clue.their_turn_handler;
            bob_handler = bob_clue_receive.my_turn_handler;
        } else {
            // Correct guess triggers reveal
            let alice_reveal_entropy = make_entropy(&mut allocator, &format!("depth{depth}_reveal"));
            let alice_reveal = call_my_turn_handler(
                &mut allocator, alice_receive.my_turn_handler, NodePtr::NIL,
                AMOUNT, state, 0, alice_reveal_entropy,
            );
            return alice_reveal.new_mover_share;
        }
    }
    unreachable!()
}

fn test_krunk_reveal_payout_at_each_depth() {
    // KRUNK_PAYOUTS = (100 100 20 5 1), base_unit = 2
    let expected: [(usize, i64); 5] = [(1, 200), (2, 200), (3, 40), (4, 10), (5, 2)];
    for (depth, expected_payout) in expected {
        let actual = play_game_to_depth(depth);
        assert_eq!(actual, expected_payout,
            "depth {depth}: expected payout {expected_payout}, got {actual}");
    }
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
        (
            "test_krunk_multi_guess_game",
            &test_krunk_multi_guess_game,
        ),
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
