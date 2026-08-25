use chia_gaming::common::standard_coin::private_to_public_key;
use chia_gaming::common::types::PrivateKey;
use chia_gaming::common::types::{AllocEncoder, Program};
use chia_gaming::games::krunk_dict_tree::{
    build_signed_dict_tree_from_bytes, expand_signatures_for_tree, generate_gap_evidence,
    reachable_gap_mask, sign_gap_evidence,
};
use chia_gaming::games::krunk_dictionary;
use clvmr::NodePtr;
use rand::prelude::*;
use std::path::PathBuf;

fn main() {
    let output_path = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("games/krunk/clsp/krunk_signed_dict_tree.clvm.bin"));
    let sk: PrivateKey = rand::rng().random();
    let pk = private_to_public_key(&sk);

    let dictionary = krunk_dictionary();
    let word_refs: Vec<&[u8]> = dictionary.iter().map(|b| b.as_ref()).collect();

    let gaps = generate_gap_evidence(&word_refs);
    let reachable_sigs = sign_gap_evidence(&sk, &pk, &gaps);

    let expanded = expand_signatures_for_tree(&word_refs, &reachable_sigs);

    let mut allocator = AllocEncoder::new();
    let tree_node = build_signed_dict_tree_from_bytes(&mut allocator, &dictionary, &expanded)
        .expect("build signed dict tree");

    let pk_bytes = pk.bytes();
    let pubkey_node = allocator
        .allocator()
        .new_atom(&pk_bytes)
        .expect("public key atom");
    let tree_tail = allocator
        .allocator()
        .new_pair(tree_node, NodePtr::NIL)
        .expect("dictionary tree list");
    let package_node = allocator
        .allocator()
        .new_pair(pubkey_node, tree_tail)
        .expect("dictionary package list");
    let package =
        Program::from_nodeptr(&allocator, package_node).expect("dictionary package to program");

    let mask = reachable_gap_mask(&word_refs);
    let reachable_count = mask.iter().filter(|r| **r).count();

    // One binary-serialized CLVM object: (dictionary_public_key dictionary_tree).
    std::fs::write(&output_path, package.bytes()).expect("write dictionary package");

    eprintln!(
        "Wrote {} ({} bytes, {} words, {} reachable gaps)",
        output_path.display(),
        package.bytes().len(),
        dictionary.len(),
        reachable_count,
    );
}
