use crate::common::types::{AllocEncoder, Error};
use clvmr::allocator::NodePtr;

use crate::common::standard_coin::partial_signer;
use crate::common::types::{Aggsig, PrivateKey, PublicKey};
use chia_bls;

/// 5-byte minimum signed value (most negative in two's complement).
pub const MIN_WORD: [u8; 5] = [0x80, 0x00, 0x00, 0x00, 0x00];
/// 5-byte maximum signed value (most positive in two's complement).
pub const MAX_WORD: [u8; 5] = [0x7f, 0xff, 0xff, 0xff, 0xff];

/// Increment a 5-byte big-endian signed integer by 1.
pub fn word_add_one(word: &[u8; 5]) -> [u8; 5] {
    let mut result = *word;
    let mut carry = true;
    for i in (0..5).rev() {
        if carry {
            let (val, overflow) = result[i].overflowing_add(1);
            result[i] = val;
            carry = overflow;
        }
    }
    result
}

/// Decrement a 5-byte big-endian signed integer by 1.
pub fn word_sub_one(word: &[u8; 5]) -> [u8; 5] {
    let mut result = *word;
    let mut borrow = true;
    for i in (0..5).rev() {
        if borrow {
            let (val, underflow) = result[i].overflowing_sub(1);
            result[i] = val;
            borrow = underflow;
        }
    }
    result
}

/// Generate all gap evidence blobs for a sorted dictionary.
///
/// For n words there are n+1 gaps. Each gap is a 10-byte blob:
/// - Gap 0: `MIN_WORD || (word[0] - 1)`
/// - Gap i (interior): `(word[i-1] + 1) || (word[i] - 1)`
/// - Gap n: `(word[n-1] + 1) || MAX_WORD`
///
/// Only *reachable* gaps are returned — gaps where left_bound <= right_bound.
/// Gaps between consecutive words (where left > right) are skipped.
pub fn generate_gap_evidence(sorted_words: &[&[u8]]) -> Vec<[u8; 10]> {
    let n = sorted_words.len();
    let mut gaps = Vec::with_capacity(n + 1);

    if n == 0 {
        let mut gap = [0u8; 10];
        gap[..5].copy_from_slice(&MIN_WORD);
        gap[5..].copy_from_slice(&MAX_WORD);
        gaps.push(gap);
        return gaps;
    }

    // First gap: MIN_WORD || (first_word - 1)
    {
        let first: [u8; 5] = sorted_words[0].try_into().expect("word must be 5 bytes");
        if first != MIN_WORD {
            let mut gap = [0u8; 10];
            gap[..5].copy_from_slice(&MIN_WORD);
            gap[5..].copy_from_slice(&word_sub_one(&first));
            gaps.push(gap);
        }
    }

    // Interior gaps: (word[i-1] + 1) || (word[i] - 1)
    for i in 1..n {
        let prev: [u8; 5] = sorted_words[i - 1]
            .try_into()
            .expect("word must be 5 bytes");
        let curr: [u8; 5] = sorted_words[i].try_into().expect("word must be 5 bytes");
        let left = word_add_one(&prev);
        let right = word_sub_one(&curr);
        // Skip if left > right (consecutive words — empty range)
        if left <= right {
            let mut gap = [0u8; 10];
            gap[..5].copy_from_slice(&left);
            gap[5..].copy_from_slice(&right);
            gaps.push(gap);
        }
    }

    // Last gap: (last_word + 1) || MAX_WORD
    {
        let last: [u8; 5] = sorted_words[n - 1]
            .try_into()
            .expect("word must be 5 bytes");
        if last != MAX_WORD {
            let mut gap = [0u8; 10];
            gap[..5].copy_from_slice(&word_add_one(&last));
            gap[5..].copy_from_slice(&MAX_WORD);
            gaps.push(gap);
        }
    }

    gaps
}

/// Returns a boolean mask of length n+1 indicating which gap positions are reachable.
/// A gap is unreachable when two adjacent words are consecutive in the integer space
/// (left_bound > right_bound).
pub fn reachable_gap_mask(sorted_words: &[&[u8]]) -> Vec<bool> {
    let n = sorted_words.len();
    let mut mask = Vec::with_capacity(n + 1);

    if n == 0 {
        mask.push(true);
        return mask;
    }

    // Gap 0: reachable unless first word == MIN_WORD
    let first: [u8; 5] = sorted_words[0].try_into().expect("word must be 5 bytes");
    mask.push(first != MIN_WORD);

    // Interior gaps
    for i in 1..n {
        let prev: [u8; 5] = sorted_words[i - 1]
            .try_into()
            .expect("word must be 5 bytes");
        let curr: [u8; 5] = sorted_words[i].try_into().expect("word must be 5 bytes");
        let left = word_add_one(&prev);
        let right = word_sub_one(&curr);
        mask.push(left <= right);
    }

    // Gap n: reachable unless last word == MAX_WORD
    let last: [u8; 5] = sorted_words[n - 1]
        .try_into()
        .expect("word must be 5 bytes");
    mask.push(last != MAX_WORD);

    mask
}

/// Expand a compact list of reachable-only signatures back to the full n+1
/// positions needed by `build_signed_dict_tree`. Unreachable positions get
/// `Aggsig::default()` (garbage placeholder).
pub fn expand_signatures_for_tree(
    sorted_words: &[&[u8]],
    reachable_sigs: &[Aggsig],
) -> Vec<Aggsig> {
    let mask = reachable_gap_mask(sorted_words);
    let mut full = Vec::with_capacity(mask.len());
    let mut sig_idx = 0;
    for &is_reachable in &mask {
        if is_reachable {
            full.push(reachable_sigs[sig_idx].clone());
            sig_idx += 1;
        } else {
            full.push(Aggsig::default());
        }
    }
    full
}

/// Serialize a list of signatures into a flat byte blob (96 bytes per sig, concatenated).
pub fn sigs_to_bytes(sigs: &[Aggsig]) -> Vec<u8> {
    let mut out = Vec::with_capacity(sigs.len() * 96);
    for sig in sigs {
        out.extend_from_slice(&sig.bytes());
    }
    out
}

/// Deserialize a flat byte blob back into individual signatures.
/// Returns an error if the blob length is not a multiple of 96.
pub fn sigs_from_bytes(blob: &[u8]) -> Result<Vec<Aggsig>, Error> {
    if !blob.len().is_multiple_of(96) {
        return Err(Error::StrErr(format!(
            "dict sig blob length {} not a multiple of 96",
            blob.len()
        )));
    }
    let mut sigs = Vec::with_capacity(blob.len() / 96);
    for chunk in blob.chunks_exact(96) {
        let mut fixed = [0u8; 96];
        fixed.copy_from_slice(chunk);
        sigs.push(Aggsig::from_bytes(fixed).unwrap_or_default());
    }
    Ok(sigs)
}
pub fn sign_gap_evidence(
    sk: &PrivateKey,
    aggregate_pk: &PublicKey,
    gaps: &[[u8; 10]],
) -> Vec<Aggsig> {
    gaps.iter()
        .map(|gap| partial_signer(sk, aggregate_pk, gap.as_slice()))
        .collect()
}

/// Verify a set of received partial signatures against the sender's public key.
/// Returns `Ok(())` if all signatures are valid and the count matches the expected
/// number of reachable gaps. Returns `Err` otherwise.
///
/// Uses basic-scheme BLS verification (pairing check) since `partial_signer`
/// does not use the augmented scheme.
pub fn verify_gap_signatures(
    sigs: &[Aggsig],
    sender_pk: &PublicKey,
    aggregate_pk: &PublicKey,
    sorted_words: &[&[u8]],
) -> Result<(), Error> {
    let gaps = generate_gap_evidence(sorted_words);
    if sigs.len() != gaps.len() {
        return Err(Error::Channel(format!(
            "dict partial sig count mismatch: got {}, expected {}",
            sigs.len(),
            gaps.len()
        )));
    }
    let g1 = chia_bls::PublicKey::generator();
    let sender_bls_pk = sender_pk.to_bls();
    let pk_bytes = aggregate_pk.bytes();
    for (i, (sig, gap)) in sigs.iter().zip(gaps.iter()).enumerate() {
        let mut msg = pk_bytes.to_vec();
        msg.extend_from_slice(gap.as_slice());
        let h = chia_bls::hash_to_g2(&msg);
        if sig.to_bls().pair(&g1) != h.pair(&sender_bls_pk) {
            return Err(Error::Channel(format!(
                "invalid dict partial signature at index {i}"
            )));
        }
    }
    Ok(())
}

/// Build a signed dictionary tree with the new node layout:
/// - Interior node: `(left_node . (right_node . (word . ())))` — proper 3-element list
/// - Leaf: a 96-byte BLS signature atom (the aggregated sig for that gap)
///
/// `sorted_words` must be sorted. `aggregated_sigs` has length `sorted_words.len() + 1`
/// (one signature per gap).
///
/// The CLVM lookup function detects interior nodes via `(l node)` (truthy for pairs)
/// and leaves via atom test (falsy for atoms = signatures).
pub fn build_signed_dict_tree(
    allocator: &mut AllocEncoder,
    sorted_words: &[&[u8]],
    aggregated_sigs: &[Aggsig],
) -> Result<NodePtr, Error> {
    build_signed_dict_tree_inner(allocator, sorted_words, aggregated_sigs, 0)
}

fn build_signed_dict_tree_inner(
    allocator: &mut AllocEncoder,
    words: &[&[u8]],
    sigs: &[Aggsig],
    gap_offset: usize,
) -> Result<NodePtr, Error> {
    if words.is_empty() {
        // Leaf: return the signature for this gap
        let sig_bytes = sigs[gap_offset].bytes();
        let node = allocator
            .allocator()
            .new_atom(&sig_bytes)
            .map_err(|e| Error::StrErr(format!("build_signed_dict_tree sig atom: {e:?}")))?;
        return Ok(node);
    }

    let mid = words.len() / 2;
    // Left subtree covers words[0..mid] with gaps gap_offset..gap_offset+mid
    let left = build_signed_dict_tree_inner(allocator, &words[..mid], sigs, gap_offset)?;
    // Right subtree covers words[mid+1..] with gaps gap_offset+mid+1..
    let right =
        build_signed_dict_tree_inner(allocator, &words[mid + 1..], sigs, gap_offset + mid + 1)?;

    let word_node = allocator
        .allocator()
        .new_atom(words[mid])
        .map_err(|e| Error::StrErr(format!("build_signed_dict_tree word atom: {e:?}")))?;

    // Build (left_node . (right_node . (word . ()))) — new node order
    let a = allocator.allocator();
    let tail = a
        .new_pair(word_node, NodePtr::NIL)
        .map_err(|e| Error::StrErr(format!("build_signed_dict_tree pair: {e:?}")))?;
    let mid_tail = a
        .new_pair(right, tail)
        .map_err(|e| Error::StrErr(format!("build_signed_dict_tree pair: {e:?}")))?;
    let node = a
        .new_pair(left, mid_tail)
        .map_err(|e| Error::StrErr(format!("build_signed_dict_tree pair: {e:?}")))?;
    Ok(node)
}

/// Convenience: build a signed dict tree from `Bytes` slices.
pub fn build_signed_dict_tree_from_bytes(
    allocator: &mut AllocEncoder,
    sorted_words: &[chia_protocol::Bytes],
    aggregated_sigs: &[Aggsig],
) -> Result<NodePtr, Error> {
    let refs: Vec<&[u8]> = sorted_words.iter().map(|b| b.as_ref()).collect();
    build_signed_dict_tree(allocator, &refs, aggregated_sigs)
}

/// Look up a word in the signed dict tree (NodePtr-based) and return the gap
/// signature if the word is NOT in the dictionary. Returns `None` if the word
/// IS in the dictionary.
///
/// This mirrors the CLVM `dict_lookup` function but runs in Rust for use when
/// building on-chain slash spends that need the BLS signature.
pub fn lookup_gap_signature(
    allocator: &mut AllocEncoder,
    tree: NodePtr,
    word: &[u8; 5],
) -> Option<Aggsig> {
    use clvmr::allocator::SExp;
    let mut node = tree;
    loop {
        match allocator.allocator().sexp(node) {
            SExp::Pair(left, rest) => {
                // Interior: (left_node right_node word_here)
                let (right_node, tail) = match allocator.allocator().sexp(rest) {
                    SExp::Pair(r, t) => (r, t),
                    _ => return None,
                };
                let (word_node, _) = match allocator.allocator().sexp(tail) {
                    SExp::Pair(w, _) => (w, ()),
                    _ => return None,
                };
                let word_here = allocator.allocator().atom(word_node);
                if word_here.as_ref() == word.as_slice() {
                    return None; // In dictionary
                }
                if word.as_slice() > word_here.as_ref() {
                    node = right_node;
                } else {
                    node = left;
                }
            }
            SExp::Atom => {
                // Leaf: 96-byte signature
                let sig_bytes = allocator.allocator().atom(node);
                if sig_bytes.len() == 96 {
                    let mut fixed = [0u8; 96];
                    fixed.copy_from_slice(sig_bytes.as_ref());
                    return Aggsig::from_bytes(fixed).ok();
                }
                return None;
            }
        }
    }
}

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
    fn test_word_add_one() {
        assert_eq!(word_add_one(&[0, 0, 0, 0, 0]), [0, 0, 0, 0, 1]);
        assert_eq!(word_add_one(&[0, 0, 0, 0, 0xff]), [0, 0, 0, 1, 0]);
        assert_eq!(word_add_one(&[0, 0, 0, 0xff, 0xff]), [0, 0, 1, 0, 0]);
        // "crane" = [99, 114, 97, 110, 101]
        assert_eq!(
            word_add_one(&[99, 114, 97, 110, 101]),
            [99, 114, 97, 110, 102]
        );
    }

    #[test]
    fn test_word_sub_one() {
        assert_eq!(word_sub_one(&[0, 0, 0, 0, 1]), [0, 0, 0, 0, 0]);
        assert_eq!(word_sub_one(&[0, 0, 0, 1, 0]), [0, 0, 0, 0, 0xff]);
        assert_eq!(word_sub_one(&[0, 0, 1, 0, 0]), [0, 0, 0, 0xff, 0xff]);
        // "crane" = [99, 114, 97, 110, 101] - 1 = [99, 114, 97, 110, 100]
        assert_eq!(
            word_sub_one(&[99, 114, 97, 110, 101]),
            [99, 114, 97, 110, 100]
        );
    }

    #[test]
    fn test_generate_gap_evidence_empty() {
        let gaps = generate_gap_evidence(&[]);
        assert_eq!(gaps.len(), 1);
        assert_eq!(&gaps[0][..5], &MIN_WORD);
        assert_eq!(&gaps[0][5..], &MAX_WORD);
    }

    #[test]
    fn test_generate_gap_evidence_single_word() {
        let words: Vec<&[u8]> = vec![b"crane"];
        let gaps = generate_gap_evidence(&words);
        assert_eq!(gaps.len(), 2);
        // Gap 0: MIN_WORD || (crane - 1)
        assert_eq!(&gaps[0][..5], &MIN_WORD);
        assert_eq!(&gaps[0][5..], &word_sub_one(b"crane"));
        // Gap 1: (crane + 1) || MAX_WORD
        assert_eq!(&gaps[1][..5], &word_add_one(b"crane"));
        assert_eq!(&gaps[1][5..], &MAX_WORD);
    }

    #[test]
    fn test_generate_gap_evidence_three_words() {
        let words: Vec<&[u8]> = vec![b"alpha", b"crane", b"world"];
        let gaps = generate_gap_evidence(&words);
        assert_eq!(gaps.len(), 4);
        // Gap 0: MIN_WORD || (alpha - 1)
        assert_eq!(&gaps[0][..5], &MIN_WORD);
        assert_eq!(&gaps[0][5..], &word_sub_one(b"alpha"));
        // Gap 1: (alpha + 1) || (crane - 1)
        assert_eq!(&gaps[1][..5], &word_add_one(b"alpha"));
        assert_eq!(&gaps[1][5..], &word_sub_one(b"crane"));
        // Gap 2: (crane + 1) || (world - 1)
        assert_eq!(&gaps[2][..5], &word_add_one(b"crane"));
        assert_eq!(&gaps[2][5..], &word_sub_one(b"world"));
        // Gap 3: (world + 1) || MAX_WORD
        assert_eq!(&gaps[3][..5], &word_add_one(b"world"));
        assert_eq!(&gaps[3][5..], &MAX_WORD);
    }

    #[test]
    fn test_build_signed_dict_tree_single_word() {
        let mut alloc = AllocEncoder::new();
        let words: Vec<&[u8]> = vec![b"crane"];
        // 2 gaps → need 2 signatures. Use default (identity) sigs for structural test.
        let sig0 = Aggsig::default();
        let sig1 = Aggsig::default();
        let sigs = vec![sig0, sig1];

        let tree = build_signed_dict_tree(&mut alloc, &words, &sigs).unwrap();

        // Interior node: (left right word)
        let (left, mid_tail) = match alloc.allocator().sexp(tree) {
            SExp::Pair(l, mt) => (l, mt),
            _ => panic!("expected pair"),
        };
        let (right, tail) = match alloc.allocator().sexp(mid_tail) {
            SExp::Pair(r, t) => (r, t),
            _ => panic!("expected pair"),
        };
        let (word_node, nil) = match alloc.allocator().sexp(tail) {
            SExp::Pair(w, n) => (w, n),
            _ => panic!("expected pair"),
        };
        assert!(is_nil(&mut alloc, nil));
        assert_eq!(atom_to_vec(&mut alloc, word_node), b"crane");

        // Left leaf = sig0 (96 bytes)
        let left_bytes = atom_to_vec(&mut alloc, left);
        assert_eq!(left_bytes.len(), 96);

        // Right leaf = sig1 (96 bytes)
        let right_bytes = atom_to_vec(&mut alloc, right);
        assert_eq!(right_bytes.len(), 96);
    }

    #[test]
    fn test_build_signed_dict_tree_three_words() {
        let mut alloc = AllocEncoder::new();
        let words: Vec<&[u8]> = vec![b"alpha", b"crane", b"world"];
        // 4 gaps → 4 default sigs
        let sigs: Vec<Aggsig> = (0..4).map(|_| Aggsig::default()).collect();
        let tree = build_signed_dict_tree(&mut alloc, &words, &sigs).unwrap();

        // Root word should be "crane" (mid of 3)
        let (left, mid_tail) = match alloc.allocator().sexp(tree) {
            SExp::Pair(l, mt) => (l, mt),
            _ => panic!("expected pair"),
        };
        let (right, tail) = match alloc.allocator().sexp(mid_tail) {
            SExp::Pair(r, t) => (r, t),
            _ => panic!("expected pair"),
        };
        let (word_node, _) = match alloc.allocator().sexp(tail) {
            SExp::Pair(w, n) => (w, n),
            _ => panic!("expected pair"),
        };
        assert_eq!(atom_to_vec(&mut alloc, word_node), b"crane");

        // Left subtree has word "alpha"
        let (ll, left_mid_tail) = match alloc.allocator().sexp(left) {
            SExp::Pair(l, mt) => (l, mt),
            _ => panic!("expected pair for left subtree"),
        };
        let (lr, left_tail) = match alloc.allocator().sexp(left_mid_tail) {
            SExp::Pair(r, t) => (r, t),
            _ => panic!("expected pair"),
        };
        let (left_word, _) = match alloc.allocator().sexp(left_tail) {
            SExp::Pair(w, n) => (w, n),
            _ => panic!("expected pair"),
        };
        assert_eq!(atom_to_vec(&mut alloc, left_word), b"alpha");
        // ll and lr are leaf signature atoms
        assert_eq!(atom_to_vec(&mut alloc, ll).len(), 96);
        assert_eq!(atom_to_vec(&mut alloc, lr).len(), 96);

        // Right subtree has word "world"
        let (rl, right_mid_tail) = match alloc.allocator().sexp(right) {
            SExp::Pair(l, mt) => (l, mt),
            _ => panic!("expected pair for right subtree"),
        };
        let (rr, right_tail) = match alloc.allocator().sexp(right_mid_tail) {
            SExp::Pair(r, t) => (r, t),
            _ => panic!("expected pair"),
        };
        let (right_word, _) = match alloc.allocator().sexp(right_tail) {
            SExp::Pair(w, n) => (w, n),
            _ => panic!("expected pair"),
        };
        assert_eq!(atom_to_vec(&mut alloc, right_word), b"world");
        assert_eq!(atom_to_vec(&mut alloc, rl).len(), 96);
        assert_eq!(atom_to_vec(&mut alloc, rr).len(), 96);
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

    #[test]
    fn test_lookup_gap_signature_in_dict() {
        let mut alloc = AllocEncoder::new();
        let words: Vec<&[u8]> = vec![b"crane", b"slate", b"world"];
        let sigs: Vec<Aggsig> = (0..=3).map(|_| Aggsig::default()).collect();
        let tree = build_signed_dict_tree(&mut alloc, &words, &sigs).unwrap();

        // Words in dict should return None
        assert!(lookup_gap_signature(&mut alloc, tree, b"crane").is_none());
        assert!(lookup_gap_signature(&mut alloc, tree, b"slate").is_none());
        assert!(lookup_gap_signature(&mut alloc, tree, b"world").is_none());
    }

    #[test]
    fn test_lookup_gap_signature_not_in_dict() {
        let mut alloc = AllocEncoder::new();
        let words: Vec<&[u8]> = vec![b"crane", b"slate", b"world"];
        let sigs: Vec<Aggsig> = (0..=3).map(|_| Aggsig::default()).collect();
        let tree = build_signed_dict_tree(&mut alloc, &words, &sigs).unwrap();

        // Words NOT in dict should return Some(signature)
        let sig = lookup_gap_signature(&mut alloc, tree, b"apple");
        assert!(sig.is_some(), "expected signature for gap word 'apple'");
        assert_eq!(sig.unwrap().bytes().len(), 96);

        let sig = lookup_gap_signature(&mut alloc, tree, b"sharp");
        assert!(sig.is_some(), "expected signature for gap word 'sharp'");

        let sig = lookup_gap_signature(&mut alloc, tree, b"zzzzz");
        assert!(sig.is_some(), "expected signature for gap word 'zzzzz'");
    }
}
