use crate::common::load_clvm::read_hex_puzzle;
use crate::common::types::{chia_dialect, Aggsig, AllocEncoder};
use crate::games::krunk_dict_tree::{build_signed_dict_tree, word_add_one, word_sub_one};
use crate::utils::proper_list;

use clvm_traits::ToClvm;
use clvmr::allocator::{NodePtr, SExp};
use clvmr::run_program;

const MIN_SENTINEL: &[u8; 5] = b"\x80\x00\x00\x00\x00";
const MAX_SENTINEL: &[u8; 5] = b"\x7f\xff\xff\xff\xff";

fn run_dict_lookup(allocator: &mut AllocEncoder, tree: NodePtr, word: &[u8]) -> NodePtr {
    let program = read_hex_puzzle(allocator, "clsp/test/test_dict_lookup.hex")
        .expect("load test_dict_lookup.hex");

    let word_node = allocator.allocator().new_atom(word).unwrap();
    let left_sentinel = allocator.allocator().new_atom(MIN_SENTINEL).unwrap();
    let right_sentinel = allocator.allocator().new_atom(MAX_SENTINEL).unwrap();

    // Build args: (tree word left_sentinel right_sentinel)
    let a = allocator.allocator();
    let t4 = a.new_pair(right_sentinel, NodePtr::NIL).unwrap();
    let t3 = a.new_pair(left_sentinel, t4).unwrap();
    let t2 = a.new_pair(word_node, t3).unwrap();
    let args = a.new_pair(tree, t2).unwrap();

    let prog_node = program.to_clvm(allocator).expect("puzzle to nodeptr");
    run_program(allocator.allocator(), &chia_dialect(), prog_node, args, 0)
        .expect("dict_lookup CLVM run failed")
        .1
}

fn is_nil(allocator: &mut AllocEncoder, node: NodePtr) -> bool {
    matches!(allocator.allocator().sexp(node), SExp::Atom)
        && allocator.allocator().atom(node).is_empty()
}

fn atom_to_vec(allocator: &mut AllocEncoder, node: NodePtr) -> Vec<u8> {
    match allocator.allocator().sexp(node) {
        SExp::Atom => allocator.allocator().atom(node).as_ref().to_vec(),
        _ => panic!("expected atom, got pair"),
    }
}

fn make_test_tree(allocator: &mut AllocEncoder, words: &[&[u8]]) -> NodePtr {
    let n = words.len();
    let sigs: Vec<Aggsig> = (0..=n).map(|_| Aggsig::default()).collect();
    build_signed_dict_tree(allocator, words, &sigs).unwrap()
}

fn test_dict_lookup_finds_word_in_dictionary() {
    let mut alloc = AllocEncoder::new();
    let words: Vec<&[u8]> = vec![b"crane", b"slate", b"trace", b"world", b"zzzzz"];
    let tree = make_test_tree(&mut alloc, &words);

    for &word in &words {
        let result = run_dict_lookup(&mut alloc, tree, word);
        assert!(
            is_nil(&mut alloc, result),
            "expected nil for word {:?} in dictionary, got non-nil",
            std::str::from_utf8(word)
        );
    }
}

fn test_dict_lookup_gap_before_first_word() {
    let mut alloc = AllocEncoder::new();
    let words: Vec<&[u8]> = vec![b"crane", b"slate", b"trace", b"world", b"zzzzz"];
    let tree = make_test_tree(&mut alloc, &words);

    // "apple" < "crane" — should fall in the gap before the first word
    let result = run_dict_lookup(&mut alloc, tree, b"apple");
    assert!(!is_nil(&mut alloc, result), "expected non-nil for gap word");
    let items = proper_list(alloc.allocator(), result, true).unwrap();
    assert_eq!(items.len(), 3);
    let left = atom_to_vec(&mut alloc, items[0]);
    let right = atom_to_vec(&mut alloc, items[1]);
    // Bounds are adjusted: left stays MIN_WORD, right is (crane - 1)
    assert_eq!(left.as_slice(), MIN_SENTINEL.as_slice());
    assert_eq!(right, word_sub_one(b"crane"));
    // Third element is the signature atom (96 bytes)
    let sig = atom_to_vec(&mut alloc, items[2]);
    assert_eq!(sig.len(), 96);
}

fn test_dict_lookup_gap_after_last_word() {
    let mut alloc = AllocEncoder::new();
    let words: Vec<&[u8]> = vec![b"crane", b"slate", b"trace", b"world", b"zzzzz"];
    let tree = make_test_tree(&mut alloc, &words);

    // After "zzzzz": use [0x7a, 0x7a, 0x7a, 0x7a, 0x7b]
    let after_last: &[u8] = &[0x7a, 0x7a, 0x7a, 0x7a, 0x7b];
    let result = run_dict_lookup(&mut alloc, tree, after_last);
    assert!(!is_nil(&mut alloc, result));
    let items = proper_list(alloc.allocator(), result, true).unwrap();
    assert_eq!(items.len(), 3);
    let left = atom_to_vec(&mut alloc, items[0]);
    let right = atom_to_vec(&mut alloc, items[1]);
    // left is (zzzzz + 1), right stays MAX_WORD
    assert_eq!(left, word_add_one(b"zzzzz"));
    assert_eq!(right.as_slice(), MAX_SENTINEL.as_slice());
    let sig = atom_to_vec(&mut alloc, items[2]);
    assert_eq!(sig.len(), 96);
}

fn test_dict_lookup_gap_between_words() {
    let mut alloc = AllocEncoder::new();
    let words: Vec<&[u8]> = vec![b"crane", b"slate", b"trace", b"world", b"zzzzz"];
    let tree = make_test_tree(&mut alloc, &words);

    // "sharp" is between "crane" and "slate"
    let result = run_dict_lookup(&mut alloc, tree, b"sharp");
    assert!(!is_nil(&mut alloc, result));
    let items = proper_list(alloc.allocator(), result, true).unwrap();
    assert_eq!(items.len(), 3);
    let left = atom_to_vec(&mut alloc, items[0]);
    let right = atom_to_vec(&mut alloc, items[1]);
    // left is (crane + 1), right is (slate - 1)
    assert_eq!(left, word_add_one(b"crane"));
    assert_eq!(right, word_sub_one(b"slate"));
    let sig = atom_to_vec(&mut alloc, items[2]);
    assert_eq!(sig.len(), 96);
}

fn test_dict_lookup_gap_xyzzy() {
    let mut alloc = AllocEncoder::new();
    let words: Vec<&[u8]> = vec![b"crane", b"slate", b"trace", b"world", b"zzzzz"];
    let tree = make_test_tree(&mut alloc, &words);

    // "xyzzy" is between "world" and "zzzzz"
    let result = run_dict_lookup(&mut alloc, tree, b"xyzzy");
    assert!(!is_nil(&mut alloc, result));
    let items = proper_list(alloc.allocator(), result, true).unwrap();
    assert_eq!(items.len(), 3);
    let left = atom_to_vec(&mut alloc, items[0]);
    let right = atom_to_vec(&mut alloc, items[1]);
    // left is (world + 1), right is (zzzzz - 1)
    assert_eq!(left, word_add_one(b"world"));
    assert_eq!(right, word_sub_one(b"zzzzz"));
    let sig = atom_to_vec(&mut alloc, items[2]);
    assert_eq!(sig.len(), 96);
}

pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
    vec![
        (
            "test_dict_lookup_finds_word_in_dictionary",
            &test_dict_lookup_finds_word_in_dictionary,
        ),
        (
            "test_dict_lookup_gap_before_first_word",
            &test_dict_lookup_gap_before_first_word,
        ),
        (
            "test_dict_lookup_gap_after_last_word",
            &test_dict_lookup_gap_after_last_word,
        ),
        (
            "test_dict_lookup_gap_between_words",
            &test_dict_lookup_gap_between_words,
        ),
        ("test_dict_lookup_gap_xyzzy", &test_dict_lookup_gap_xyzzy),
    ]
}
