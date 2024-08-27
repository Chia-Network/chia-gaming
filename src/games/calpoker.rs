use num_bigint::{BigInt, ToBigInt};
use num_traits::ToPrimitive;

use crate::common::types::{divmod, Amount, Sha256Input};

fn mergein(outer: &[usize], inner: &[usize], offset: usize) -> Vec<usize> {
    if inner.is_empty() {
        outer.to_vec()
    } else {
        let first = inner[0] + offset;
        let mut res = Vec::new();
        if outer.is_empty() {
            res.push(first);
            res.append(&mut mergein(&[], &inner[1..], offset));
        } else if outer[0] <= first {
            res.push(outer[0]);
            res.append(&mut mergein(&outer[1..], inner, offset + 1));
        } else {
            res.push(first);
            res.append(&mut mergein(outer, &inner[1..], offset));
        }
        res
    }
}

fn mergeover(outer: &[usize], inner: &[usize], offset: usize) -> Vec<usize> {
    if inner.is_empty() {
        vec![]
    } else {
        let first = inner[0] + offset;
        let mut res = Vec::new();
        if outer.is_empty() {
            res.push(first);
            res.append(&mut mergeover(&[], &inner[1..], offset));
        } else if outer[0] <= first {
            return mergeover(&outer[1..], inner, offset + 1);
        } else {
            res.push(first);
            res.append(&mut mergeover(outer, &inner[1..], offset));
        }
        res
    }
}

// Pick numchoose things out of numcards options with randomness extracted from vals
// returns (cards newvals).
fn choose(numcards: usize, numchoose: usize, randomness: BigInt) -> (Vec<usize>, BigInt) {
    if numchoose == 1 {
        let (newrandomness, card) = divmod(randomness, numcards.to_bigint().unwrap());
        (vec![card.to_usize().unwrap()], newrandomness)
    } else {
        let half = numchoose >> 1;
        let (cards1, newrandomness2) = choose(numcards, half, randomness);
        let (cards2, newrandomness3) = choose(numcards - half, numchoose - half, newrandomness2);
        (mergein(&cards1, &cards2, 0), newrandomness3)
    }
}

fn cards_to_hand(cards: &[usize]) -> Vec<(usize, usize)> {
    cards
        .iter()
        .map(|val| {
            let rank = val / 4;
            let suit = val % 4;
            if rank == 12 {
                (1, suit + 1)
            } else {
                (rank + 2, suit + 1)
            }
        })
        .collect()
}

// Does the same thing as make_cards so bob can see the card display that alice can see once
// the message of alice' preimage (alice_hash) goes through.
pub fn make_cards(
    alice_hash: &[u8],
    bob_hash: &[u8],
    amount: Amount,
) -> (Vec<(usize, usize)>, Vec<(usize, usize)>) {
    let amount_bigint = amount.to_u64().to_bigint().unwrap();
    let (_, mut amount_bytes) = amount_bigint.to_bytes_be();
    if amount_bytes == [0] {
        amount_bytes = vec![];
    }
    if amount_bytes[0] & 0x80 != 0 {
        amount_bytes.insert(0, 0);
    }
    eprintln!(
        "make cards with alice_hash {alice_hash:?} bob_hash {bob_hash:?} amount {amount_bytes:?}"
    );
    let rand_input = Sha256Input::Array(vec![
        Sha256Input::Bytes(&alice_hash[..16]),
        Sha256Input::Bytes(&bob_hash[..16]),
        Sha256Input::Bytes(&amount_bytes),
    ])
    .hash()
    .bytes()
    .to_vec();
    let randomness = BigInt::from_signed_bytes_be(&rand_input);
    let (handa, newrandomness) = choose(52, 8, randomness);
    let (handb, _) = choose(52 - 8, 8, newrandomness);
    (
        cards_to_hand(&handa),
        cards_to_hand(&mergeover(&handa, &handb, 0)),
    )
}
