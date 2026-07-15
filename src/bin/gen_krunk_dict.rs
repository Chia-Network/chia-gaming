use chia_gaming::common::standard_coin::private_to_public_key;
use chia_gaming::common::types::PrivateKey;
use chia_gaming::common::types::{AllocEncoder, Program};
use chia_gaming::games::krunk_dict_tree::{
    build_signed_dict_tree_from_bytes, expand_signatures_for_tree, generate_gap_evidence,
    reachable_gap_mask, sign_gap_evidence,
};
use chia_gaming::games::krunk_dictionary;
use rand::prelude::*;

fn main() {
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
    let tree_program = Program::from_nodeptr(&allocator, tree_node).expect("tree to program");

    let pk_bytes = pk.bytes();
    let tree_bytes = tree_program.bytes();

    let mask = reachable_gap_mask(&word_refs);
    let reachable_count = mask.iter().filter(|r| **r).count();

    // .dat format: 48-byte BLS public key followed by serialized CLVM tree.
    let mut dat = Vec::with_capacity(pk_bytes.len() + tree_bytes.len());
    dat.extend_from_slice(&pk_bytes);
    dat.extend_from_slice(tree_bytes);

    let dat_path = "clsp/games/krunk/krunk_signed_dict_tree.dat";
    std::fs::write(dat_path, &dat).expect("write dat");

    eprintln!(
        "Wrote {} ({} bytes: 48 pubkey + {} tree, {} words, {} reachable gaps)",
        dat_path,
        dat.len(),
        tree_bytes.len(),
        dictionary.len(),
        reachable_count,
    );
}
