use crate::common::load_clvm::read_hex_puzzle;
use crate::common::types::{chia_dialect, AllocEncoder, Puzzle, Sha256tree};
use crate::utils::proper_list;

use clvm_traits::ToClvm;
use clvmr::allocator::{NodePtr, SExp};
use clvmr::run_program;

const AMOUNT: i64 = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MoveCode {
    MakeMove = 0,
    Slash = 2,
}

fn int_from_atom(allocator: &mut AllocEncoder, node: NodePtr) -> i64 {
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
        _ => panic!("expected atom"),
    }
}

fn build_curry_args(
    allocator: &mut AllocEncoder,
    move_node: NodePtr,
    max_move_size: i64,
    mover_share: i64,
) -> NodePtr {
    let amount_node = AMOUNT.to_clvm(allocator).unwrap();
    let mms_node = max_move_size.to_clvm(allocator).unwrap();
    let ms_node = mover_share.to_clvm(allocator).unwrap();

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
}

fn run_validator_step(
    allocator: &mut AllocEncoder,
    puzzle: &Puzzle,
    move_bytes: &[u8],
    max_move_size: i64,
    mover_share: i64,
    previous_state: NodePtr,
    evidence: NodePtr,
) -> (MoveCode, NodePtr) {
    let validator_hash = puzzle.sha256tree(allocator);
    let vh_node = allocator
        .allocator()
        .new_atom(validator_hash.hash().bytes())
        .unwrap();
    let move_node = allocator.allocator().new_atom(move_bytes).unwrap();
    let program_clvm = puzzle.to_clvm(allocator).unwrap();
    let curry_args = build_curry_args(allocator, move_node, max_move_size, mover_share);

    let a = allocator.allocator();
    let tail = a.new_pair(NodePtr::NIL, NodePtr::NIL).unwrap();
    let tail = a.new_pair(evidence, tail).unwrap();
    let tail = a.new_pair(program_clvm, tail).unwrap();
    let tail = a.new_pair(previous_state, tail).unwrap();
    let tail = a.new_pair(curry_args, tail).unwrap();
    let args = a.new_pair(vh_node, tail).unwrap();

    let result = run_program(allocator.allocator(), &chia_dialect(), program_clvm, args, 0)
        .expect("validator run failed")
        .1;

    let items = proper_list(allocator.allocator(), result, true).unwrap();
    if items.is_empty() {
        (MoveCode::Slash, result)
    } else {
        (MoveCode::MakeMove, result)
    }
}

fn words_to_list(allocator: &mut AllocEncoder, words: &[&str]) -> NodePtr {
    let mut tail = NodePtr::NIL;
    for word in words.iter().rev() {
        let w = allocator.allocator().new_atom(word.as_bytes()).unwrap();
        tail = allocator.allocator().new_pair(w, tail).unwrap();
    }
    tail
}

/// Build a state shaped like the post-commit guess state:
/// (bob_guesses alice_clues alice_commit clue_hash). clue_hash is opaque
/// for these tests; the validators only read/write it positionally.
fn make_state_after_commit(allocator: &mut AllocEncoder, commit: [u8; 32]) -> NodePtr {
    let a = allocator.allocator();
    let commit_node = a.new_atom(&commit).unwrap();
    let dummy_clue_hash = a.new_atom(&[0xEE; 32]).unwrap();
    let tail = a.new_pair(dummy_clue_hash, NodePtr::NIL).unwrap();
    let tail = a.new_pair(commit_node, tail).unwrap();
    let tail = a.new_pair(NodePtr::NIL, tail).unwrap();
    a.new_pair(NodePtr::NIL, tail).unwrap()
}

fn test_krunk_commit_happy() {
    let mut allocator = AllocEncoder::new();
    let commit = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/commit.hex").unwrap();
    let move_bytes = [0xAB; 32];
    let (code, result) = run_validator_step(
        &mut allocator,
        &commit,
        &move_bytes,
        32,
        0,
        NodePtr::NIL,
        NodePtr::NIL,
    );
    assert_eq!(code, MoveCode::MakeMove);
    let items = proper_list(allocator.allocator(), result, true).unwrap();
    // New state element 0 = next_validator_hash, 1 = new_state, 2 = max_move_size
    assert_eq!(int_from_atom(&mut allocator, items[2]), 5);
}

fn test_krunk_commit_slash_bad_move_size() {
    let mut allocator = AllocEncoder::new();
    let commit = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/commit.hex").unwrap();
    let (code, _) = run_validator_step(
        &mut allocator,
        &commit,
        b"short",
        32,
        0,
        NodePtr::NIL,
        NodePtr::NIL,
    );
    assert_eq!(code, MoveCode::Slash);
}

fn test_krunk_guess_slash_invalid_word() {
    let mut allocator = AllocEncoder::new();
    let guess = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/guess.hex").unwrap();
    let dictionary = words_to_list(&mut allocator, &["crane", "slate"]);
    let state = make_state_after_commit(&mut allocator, [0xCD; 32]);
    let (code, _) = run_validator_step(
        &mut allocator,
        &guess,
        b"xyzzy",
        5,
        0,
        state,
        dictionary,
    );
    assert_eq!(code, MoveCode::Slash);
}

fn test_krunk_guess_happy() {
    let mut allocator = AllocEncoder::new();
    let guess = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/guess.hex").unwrap();
    let state = make_state_after_commit(&mut allocator, [0xCD; 32]);
    let (code, result) = run_validator_step(
        &mut allocator,
        &guess,
        b"crane",
        5,
        0,
        state,
        NodePtr::NIL,
    );
    assert_eq!(code, MoveCode::MakeMove);
    let items = proper_list(allocator.allocator(), result, true).unwrap();
    assert_eq!(int_from_atom(&mut allocator, items[2]), 21);
}

pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
    vec![
        ("test_krunk_commit_happy", &test_krunk_commit_happy),
        (
            "test_krunk_commit_slash_bad_move_size",
            &test_krunk_commit_slash_bad_move_size,
        ),
        (
            "test_krunk_guess_slash_invalid_word",
            &test_krunk_guess_slash_invalid_word,
        ),
        ("test_krunk_guess_happy", &test_krunk_guess_happy),
    ]
}
