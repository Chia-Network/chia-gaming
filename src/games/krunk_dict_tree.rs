use crate::common::types::{AllocEncoder, Error};
use clvmr::allocator::NodePtr;

/// Build a balanced binary search tree from a sorted slice of 5-byte words.
///
/// The resulting CLVM structure:
/// - Interior node: `(left_child word right_child)` — a proper 3-element list
/// - Leaf: `()` (nil) — represents a gap between adjacent words
///
/// Lookup depth is O(log n) for n words, eliminating the stack overflow
/// that occurred with linear scans of large dictionaries.
pub fn build_dict_tree(
    allocator: &mut AllocEncoder,
    sorted_words: &[&[u8]],
) -> Result<NodePtr, Error> {
    if sorted_words.is_empty() {
        return Ok(NodePtr::NIL);
    }
    let mid = sorted_words.len() / 2;
    let left = build_dict_tree(allocator, &sorted_words[..mid])?;
    let right = build_dict_tree(allocator, &sorted_words[mid + 1..])?;

    let word_node = allocator
        .allocator()
        .new_atom(sorted_words[mid])
        .map_err(|e| Error::StrErr(format!("build_dict_tree atom: {e:?}")))?;

    // Build (left_child word right_child) as a proper list:
    // (left_child . (word . (right_child . ())))
    let a = allocator.allocator();
    let tail = a
        .new_pair(right, NodePtr::NIL)
        .map_err(|e| Error::StrErr(format!("build_dict_tree pair: {e:?}")))?;
    let mid_tail = a
        .new_pair(word_node, tail)
        .map_err(|e| Error::StrErr(format!("build_dict_tree pair: {e:?}")))?;
    let node = a
        .new_pair(left, mid_tail)
        .map_err(|e| Error::StrErr(format!("build_dict_tree pair: {e:?}")))?;
    Ok(node)
}

/// Build a dict tree from a slice of `Bytes` (the format used by the existing
/// dictionary loader). Words must already be sorted.
pub fn build_dict_tree_from_bytes(
    allocator: &mut AllocEncoder,
    sorted_words: &[chia_protocol::Bytes],
) -> Result<NodePtr, Error> {
    let refs: Vec<&[u8]> = sorted_words.iter().map(|b| b.as_ref()).collect();
    build_dict_tree(allocator, &refs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::types::AllocEncoder;
    use clvmr::allocator::SExp;

    fn is_nil(allocator: &mut AllocEncoder, node: NodePtr) -> bool {
        matches!(allocator.allocator().sexp(node), SExp::Atom)
            && allocator.allocator().atom(node).is_empty()
    }

    fn atom_to_vec(allocator: &mut AllocEncoder, node: NodePtr) -> Vec<u8> {
        match allocator.allocator().sexp(node) {
            SExp::Atom => allocator.allocator().atom(node).as_ref().to_vec(),
            _ => panic!("expected atom"),
        }
    }

    /// Extract (left, word_bytes, right) from an interior node.
    fn destructure_node(
        allocator: &mut AllocEncoder,
        node: NodePtr,
    ) -> (NodePtr, Vec<u8>, NodePtr) {
        let (left, mid_tail) = match allocator.allocator().sexp(node) {
            SExp::Pair(l, mt) => (l, mt),
            _ => panic!("expected pair for interior node"),
        };
        let (word_node, tail) = match allocator.allocator().sexp(mid_tail) {
            SExp::Pair(w, t) => (w, t),
            _ => panic!("expected pair for word+tail"),
        };
        let (right, nil) = match allocator.allocator().sexp(tail) {
            SExp::Pair(r, n) => (r, n),
            _ => panic!("expected pair for right+nil"),
        };
        assert!(is_nil(allocator, nil), "expected proper list");
        let word = atom_to_vec(allocator, word_node);
        (left, word, right)
    }

    #[test]
    fn test_empty_dictionary_is_nil() {
        let mut alloc = AllocEncoder::new();
        let tree = build_dict_tree(&mut alloc, &[]).unwrap();
        assert!(is_nil(&mut alloc, tree));
    }

    #[test]
    fn test_single_word_tree() {
        let mut alloc = AllocEncoder::new();
        let words: Vec<&[u8]> = vec![b"crane"];
        let tree = build_dict_tree(&mut alloc, &words).unwrap();
        let (left, word, right) = destructure_node(&mut alloc, tree);
        assert_eq!(word, b"crane");
        assert!(is_nil(&mut alloc, left));
        assert!(is_nil(&mut alloc, right));
    }

    #[test]
    fn test_three_word_balanced() {
        let mut alloc = AllocEncoder::new();
        let words: Vec<&[u8]> = vec![b"alpha", b"bravo", b"crane"];
        let tree = build_dict_tree(&mut alloc, &words).unwrap();

        let (left, root_word, right) = destructure_node(&mut alloc, tree);
        assert_eq!(root_word, b"bravo");

        let (ll, lw, lr) = destructure_node(&mut alloc, left);
        assert_eq!(lw, b"alpha");
        assert!(is_nil(&mut alloc, ll));
        assert!(is_nil(&mut alloc, lr));

        let (rl, rw, rr) = destructure_node(&mut alloc, right);
        assert_eq!(rw, b"crane");
        assert!(is_nil(&mut alloc, rl));
        assert!(is_nil(&mut alloc, rr));
    }

    #[test]
    fn test_five_word_tree_depth() {
        let mut alloc = AllocEncoder::new();
        let words: Vec<&[u8]> = vec![b"alpha", b"bravo", b"crane", b"delta", b"eagle"];
        let tree = build_dict_tree(&mut alloc, &words).unwrap();

        let (left, root_word, right) = destructure_node(&mut alloc, tree);
        assert_eq!(root_word, b"crane");

        let (_, lw, _) = destructure_node(&mut alloc, left);
        assert_eq!(lw, b"bravo");

        // Right half is ["delta", "eagle"], mid = 1, root = "eagle"
        let (_, rw, _) = destructure_node(&mut alloc, right);
        assert_eq!(rw, b"eagle");
    }

    #[test]
    fn test_large_dictionary_depth() {
        let mut alloc = AllocEncoder::new();
        let word_data: Vec<[u8; 5]> = (0u32..4775)
            .map(|i| {
                let b = i.to_be_bytes();
                [b[0], b[1], b[2], b[3], 0x41]
            })
            .collect();
        let words: Vec<&[u8]> = word_data.iter().map(|w| w.as_slice()).collect();
        let tree = build_dict_tree(&mut alloc, &words).unwrap();

        assert!(
            !is_nil(&mut alloc, tree),
            "tree of 4775 words should not be nil"
        );

        let mut node = tree;
        let mut depth = 0;
        loop {
            match alloc.allocator().sexp(node) {
                SExp::Pair(left, _) => {
                    node = left;
                    depth += 1;
                }
                SExp::Atom => break,
            }
        }
        assert!(depth <= 14, "tree depth {depth} exceeds expected bound");
        assert!(depth >= 10, "tree depth {depth} is unexpectedly shallow");
    }
}
