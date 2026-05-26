use crate::common::load_clvm::read_hex_puzzle;
use crate::common::types::{chia_dialect, AllocEncoder, Puzzle, Sha256tree};
use crate::utils::proper_list;

use clvm_traits::ToClvm;
use clvmr::allocator::{NodePtr, SExp};
use clvmr::run_program;

const AMOUNT: i64 = 200;
const BASE_UNIT: i64 = 2;

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
) -> Result<(MoveCode, NodePtr), String> {
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

    match run_program(allocator.allocator(), &chia_dialect(), program_clvm, args, 0) {
        Ok(reduction) => {
            let result = reduction.1;
            let items = proper_list(allocator.allocator(), result, true).unwrap();
            if items.is_empty() {
                Ok((MoveCode::Slash, result))
            } else {
                Ok((MoveCode::MakeMove, result))
            }
        }
        Err(e) => Err(format!("CLVM error: {e:?}")),
    }
}

/// Build state: (dict_pubkey base_unit bob_guesses alice_clues alice_commit clue_hash)
fn make_state_after_commit(allocator: &mut AllocEncoder, dict_pubkey: NodePtr, commit: [u8; 32]) -> NodePtr {
    let base_unit_node = BASE_UNIT.to_clvm(allocator).unwrap();
    let a = allocator.allocator();
    let commit_node = a.new_atom(&commit).unwrap();
    let dummy_clue_hash = a.new_atom(&[0xEE; 32]).unwrap();
    let tail = a.new_pair(dummy_clue_hash, NodePtr::NIL).unwrap();
    let tail = a.new_pair(commit_node, tail).unwrap();
    let tail = a.new_pair(NodePtr::NIL, tail).unwrap();
    let tail = a.new_pair(NodePtr::NIL, tail).unwrap();
    let tail = a.new_pair(base_unit_node, tail).unwrap();
    a.new_pair(dict_pubkey, tail).unwrap()
}

/// Build state with guesses: (dict_pubkey base_unit bob_guesses alice_clues alice_commit clue_hash)
fn make_state_with_guesses(
    allocator: &mut AllocEncoder,
    dict_pubkey: NodePtr,
    bob_guesses: NodePtr,
    alice_clues: NodePtr,
    commit: [u8; 32],
) -> NodePtr {
    let base_unit_node = BASE_UNIT.to_clvm(allocator).unwrap();
    let a = allocator.allocator();
    let commit_node = a.new_atom(&commit).unwrap();
    let dummy_clue_hash = a.new_atom(&[0xEE; 32]).unwrap();
    let tail = a.new_pair(dummy_clue_hash, NodePtr::NIL).unwrap();
    let tail = a.new_pair(commit_node, tail).unwrap();
    let tail = a.new_pair(alice_clues, tail).unwrap();
    let tail = a.new_pair(bob_guesses, tail).unwrap();
    let tail = a.new_pair(base_unit_node, tail).unwrap();
    a.new_pair(dict_pubkey, tail).unwrap()
}

fn make_dict_pubkey(allocator: &mut AllocEncoder) -> NodePtr {
    allocator.allocator().new_atom(&[0xAA; 48]).unwrap()
}

fn words_to_list(allocator: &mut AllocEncoder, words: &[&[u8; 5]]) -> NodePtr {
    let mut tail = NodePtr::NIL;
    for word in words.iter().rev() {
        let w = allocator.allocator().new_atom(word.as_slice()).unwrap();
        tail = allocator.allocator().new_pair(w, tail).unwrap();
    }
    tail
}

// --- commit.clsp tests ---

fn test_krunk_commit_happy() {
    let mut allocator = AllocEncoder::new();
    let commit = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/commit.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);
    let base_unit_node = BASE_UNIT.to_clvm(&mut allocator).unwrap();
    let initial_state = {
        let a = allocator.allocator();
        let tail = a.new_pair(base_unit_node, NodePtr::NIL).unwrap();
        a.new_pair(dict_pubkey, tail).unwrap()
    };
    let move_bytes = [0xAB; 32];
    let (code, result) = run_validator_step(
        &mut allocator,
        &commit,
        &move_bytes,
        32,
        0,
        initial_state,
        NodePtr::NIL,
    ).unwrap();
    assert_eq!(code, MoveCode::MakeMove);
    let items = proper_list(allocator.allocator(), result, true).unwrap();
    assert_eq!(int_from_atom(&mut allocator, items[2]), 5);
}

fn test_krunk_commit_slash_bad_move_size() {
    let mut allocator = AllocEncoder::new();
    let commit = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/commit.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);
    let base_unit_node = BASE_UNIT.to_clvm(&mut allocator).unwrap();
    let initial_state = {
        let a = allocator.allocator();
        let tail = a.new_pair(base_unit_node, NodePtr::NIL).unwrap();
        a.new_pair(dict_pubkey, tail).unwrap()
    };
    let result = run_validator_step(
        &mut allocator,
        &commit,
        b"short",
        32,
        0,
        initial_state,
        NodePtr::NIL,
    );
    assert!(result.is_err() || result.unwrap().0 == MoveCode::Slash);
}

// --- guess.clsp tests ---

fn test_krunk_guess_happy() {
    let mut allocator = AllocEncoder::new();
    let guess = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/guess.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);
    let state = make_state_after_commit(&mut allocator, dict_pubkey, [0xCD; 32]);
    let (code, result) = run_validator_step(
        &mut allocator,
        &guess,
        b"crane",
        5,
        0,
        state,
        NodePtr::NIL,
    ).unwrap();
    assert_eq!(code, MoveCode::MakeMove);
    let items = proper_list(allocator.allocator(), result, true).unwrap();
    assert_eq!(items.len(), 3, "valid guess returns 3 elements (no conditions)");
    assert_eq!(int_from_atom(&mut allocator, items[2]), 21);
}

fn test_krunk_guess_slash_bob_out_of_dict() {
    let mut allocator = AllocEncoder::new();
    let guess = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/guess.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);
    let state = make_state_after_commit(&mut allocator, dict_pubkey, [0xCD; 32]);

    // 10-byte evidence: begin_range || end_range that brackets "xyzzy"
    // "xyzzy" as bytes = [0x78, 0x79, 0x7a, 0x7a, 0x79]
    // begin_range < "xyzzy" < end_range
    let begin_range = b"xyzzx"; // just below xyzzy
    let end_range = b"xyzzz"; // just above xyzzy
    let mut evidence_bytes = Vec::new();
    evidence_bytes.extend_from_slice(begin_range);
    evidence_bytes.extend_from_slice(end_range);
    let evidence = allocator.allocator().new_atom(&evidence_bytes).unwrap();

    let (code, result) = run_validator_step(
        &mut allocator,
        &guess,
        b"xyzzy",
        5,
        0,
        state,
        evidence,
    ).unwrap();
    assert_eq!(code, MoveCode::MakeMove);
    let items = proper_list(allocator.allocator(), result, true).unwrap();
    assert_eq!(items.len(), 4, "slash with evidence returns 4 elements (vh state mms condition)");
    // 4th element should be the AGG_SIG_UNSAFE condition
    let condition = proper_list(allocator.allocator(), items[3], true).unwrap();
    assert_eq!(int_from_atom(&mut allocator, condition[0]), 49, "AGG_SIG_UNSAFE code");
}

fn test_krunk_guess_bad_range_doesnt_bracket() {
    let mut allocator = AllocEncoder::new();
    let guess = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/guess.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);
    let state = make_state_after_commit(&mut allocator, dict_pubkey, [0xCD; 32]);

    // Evidence range that does NOT bracket the move "crane"
    // begin = "death", end = "denom" — both > "crane", so crane < begin
    let mut evidence_bytes = Vec::new();
    evidence_bytes.extend_from_slice(b"death");
    evidence_bytes.extend_from_slice(b"denom");
    let evidence = allocator.allocator().new_atom(&evidence_bytes).unwrap();

    let result = run_validator_step(
        &mut allocator,
        &guess,
        b"crane",
        5,
        0,
        state,
        evidence,
    );
    assert!(result.is_err(), "should fail when evidence range doesn't bracket the move");
}

// --- clue.clsp tests ---

fn test_krunk_clue_nonterminal_happy() {
    let mut allocator = AllocEncoder::new();
    let clue = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/clue.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);

    let bob_guesses = words_to_list(&mut allocator, &[b"crane"]);
    let state = make_state_with_guesses(
        &mut allocator,
        dict_pubkey,
        bob_guesses,
        NodePtr::NIL,
        [0xCD; 32],
    );

    // 1-byte clue move (any byte value for the encoded clue)
    let (code, result) = run_validator_step(
        &mut allocator,
        &clue,
        &[0x42],
        21,
        0,
        state,
        NodePtr::NIL,
    ).unwrap();
    assert_eq!(code, MoveCode::MakeMove);
    let items = proper_list(allocator.allocator(), result, true).unwrap();
    assert_eq!(items.len(), 3, "clue returns 3 elements");
    assert_eq!(int_from_atom(&mut allocator, items[2]), 5, "next max_move_size = 5 (guess)");
}

fn test_krunk_clue_blocks_5th_clue() {
    let mut allocator = AllocEncoder::new();
    let clue = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/clue.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);

    // 4 clues already given (alice_clues has 4 elements)
    let bob_guesses = words_to_list(&mut allocator, &[b"crane", b"slate", b"mango", b"plumb", b"toast"]);
    let clue_a = allocator.allocator().new_atom(&[0x01]).unwrap();
    let clue_b = allocator.allocator().new_atom(&[0x02]).unwrap();
    let clue_c = allocator.allocator().new_atom(&[0x03]).unwrap();
    let clue_d = allocator.allocator().new_atom(&[0x04]).unwrap();
    let a = allocator.allocator();
    let alice_clues = {
        let t = a.new_pair(clue_d, NodePtr::NIL).unwrap();
        let t = a.new_pair(clue_c, t).unwrap();
        let t = a.new_pair(clue_b, t).unwrap();
        a.new_pair(clue_a, t).unwrap()
    };

    let state = make_state_with_guesses(
        &mut allocator,
        dict_pubkey,
        bob_guesses,
        alice_clues,
        [0xCD; 32],
    );

    // Try giving a 5th clue — should fail (< 4 check fails)
    let result = run_validator_step(
        &mut allocator,
        &clue,
        &[0x05],
        21,
        0,
        state,
        NodePtr::NIL,
    );
    assert!(result.is_err() || result.unwrap().0 == MoveCode::Slash,
        "5th clue should be rejected (enforces reveal)");
}

fn test_krunk_reveal_slash_alice_out_of_dict() {
    let mut allocator = AllocEncoder::new();
    let clue = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/clue.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);

    let bob_guesses = words_to_list(&mut allocator, &[b"crane"]);
    let state = make_state_with_guesses(
        &mut allocator,
        dict_pubkey,
        bob_guesses,
        NodePtr::NIL,
        [0xCD; 32],
    );

    // Alice reveals salt||word where word = "xyzzy" (not in dictionary)
    let salt = [0x11; 16];
    let word = b"xyzzy";
    let mut reveal_move = Vec::new();
    reveal_move.extend_from_slice(&salt);
    reveal_move.extend_from_slice(word);

    // Evidence brackets "xyzzy"
    let mut evidence_bytes = Vec::new();
    evidence_bytes.extend_from_slice(b"xyzzx");
    evidence_bytes.extend_from_slice(b"xyzzz");
    let evidence = allocator.allocator().new_atom(&evidence_bytes).unwrap();

    let (code, result) = run_validator_step(
        &mut allocator,
        &clue,
        &reveal_move,
        21,
        0,
        state,
        evidence,
    ).unwrap();
    assert_eq!(code, MoveCode::MakeMove);
    let items = proper_list(allocator.allocator(), result, true).unwrap();
    assert_eq!(items.len(), 4, "reveal slash returns 4 elements (terminal + condition)");
    // Check the condition is AGG_SIG_UNSAFE
    let condition = proper_list(allocator.allocator(), items[3], true).unwrap();
    assert_eq!(int_from_atom(&mut allocator, condition[0]), 49, "AGG_SIG_UNSAFE code");
}

fn test_krunk_reveal_bad_range_doesnt_bracket() {
    let mut allocator = AllocEncoder::new();
    let clue = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/clue.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);

    let bob_guesses = words_to_list(&mut allocator, &[b"crane"]);
    let state = make_state_with_guesses(
        &mut allocator,
        dict_pubkey,
        bob_guesses,
        NodePtr::NIL,
        [0xCD; 32],
    );

    let salt = [0x11; 16];
    let word = b"crane";
    let mut reveal_move = Vec::new();
    reveal_move.extend_from_slice(&salt);
    reveal_move.extend_from_slice(word);

    // Evidence that does NOT bracket "crane"
    let mut evidence_bytes = Vec::new();
    evidence_bytes.extend_from_slice(b"death");
    evidence_bytes.extend_from_slice(b"denom");
    let evidence = allocator.allocator().new_atom(&evidence_bytes).unwrap();

    let result = run_validator_step(
        &mut allocator,
        &clue,
        &reveal_move,
        21,
        0,
        state,
        evidence,
    );
    assert!(result.is_err(), "should fail when evidence range doesn't bracket the revealed word");
}

fn test_krunk_reveal_valid() {
    let mut allocator = AllocEncoder::new();
    let clue = read_hex_puzzle(&mut allocator, "clsp/games/krunk/onchain/clue.hex").unwrap();
    let dict_pubkey = make_dict_pubkey(&mut allocator);

    let word = b"crane";
    let salt = [0x22; 16];
    let commit = {
        use sha2::{Sha256, Digest};
        let mut hasher = Sha256::new();
        hasher.update(&salt);
        hasher.update(word);
        let result = hasher.finalize();
        let mut h = [0u8; 32];
        h.copy_from_slice(&result);
        h
    };

    // Bob guessed "crane" as the latest guess (first in list)
    let bob_guesses = words_to_list(&mut allocator, &[b"crane"]);
    let state = make_state_with_guesses(
        &mut allocator,
        dict_pubkey,
        bob_guesses,
        NodePtr::NIL,
        commit,
    );

    let mut reveal_move = Vec::new();
    reveal_move.extend_from_slice(&salt);
    reveal_move.extend_from_slice(word);

    // mover_share for 1 guess correct = 100% of (amount/100)*100 = amount
    let mover_share = AMOUNT;
    let (code, result) = run_validator_step(
        &mut allocator,
        &clue,
        &reveal_move,
        21,
        mover_share,
        state,
        NodePtr::NIL,
    ).unwrap();
    assert_eq!(code, MoveCode::MakeMove);
    let items = proper_list(allocator.allocator(), result, true).unwrap();
    assert_eq!(items.len(), 3, "valid reveal returns terminal (0 0 0)");
    assert_eq!(int_from_atom(&mut allocator, items[0]), 0);
    assert_eq!(int_from_atom(&mut allocator, items[1]), 0);
    assert_eq!(int_from_atom(&mut allocator, items[2]), 0);
}

pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
    vec![
        ("test_krunk_commit_happy", &test_krunk_commit_happy),
        (
            "test_krunk_commit_slash_bad_move_size",
            &test_krunk_commit_slash_bad_move_size,
        ),
        ("test_krunk_guess_happy", &test_krunk_guess_happy),
        (
            "test_krunk_guess_slash_bob_out_of_dict",
            &test_krunk_guess_slash_bob_out_of_dict,
        ),
        (
            "test_krunk_guess_bad_range_doesnt_bracket",
            &test_krunk_guess_bad_range_doesnt_bracket,
        ),
        (
            "test_krunk_clue_nonterminal_happy",
            &test_krunk_clue_nonterminal_happy,
        ),
        (
            "test_krunk_clue_blocks_5th_clue",
            &test_krunk_clue_blocks_5th_clue,
        ),
        (
            "test_krunk_reveal_slash_alice_out_of_dict",
            &test_krunk_reveal_slash_alice_out_of_dict,
        ),
        (
            "test_krunk_reveal_bad_range_doesnt_bracket",
            &test_krunk_reveal_bad_range_doesnt_bracket,
        ),
        ("test_krunk_reveal_valid", &test_krunk_reveal_valid),
    ]
}
