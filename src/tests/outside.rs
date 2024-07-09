use std::collections::VecDeque;

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

use crate::common::types::{AllocEncoder, Amount, CoinID, CoinString, Error, PrivateKey};
use crate::common::standard_coin::{private_to_public_key, puzzle_hash_for_pk};
use crate::outside::{PacketSender, Peer, PeerMessage};
use crate::channel_handler::types::ChannelHandlerPrivateKeys;

#[derive(Default)]
struct Pipe {
    queue: VecDeque<Vec<u8>>
}

impl PacketSender for Pipe {
    fn send_message(&mut self, msg: &PeerMessage) -> Result<(), Error> {
        let bson_doc = bson::to_bson(&msg).map_err(|e| Error::StrErr(format!("{e:?}")))?;
        let msg_data = bson::to_vec(&bson_doc).map_err(|e| Error::StrErr(format!("{e:?}")))?;
        self.queue.push_back(msg_data);
        Ok(())
    }
}

#[test]
fn test_peer_smoke() {
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let mut allocator = AllocEncoder::new();

    let private_keys1: ChannelHandlerPrivateKeys = rng.gen();
    let reward_private_key1: PrivateKey = rng.gen();
    let reward_public_key1 = private_to_public_key(&reward_private_key1);
    let reward_puzzle_hash1 = puzzle_hash_for_pk(&mut allocator, &reward_public_key1).expect("should work");

    let mut pipe_sender: [Pipe; 2] = Default::default();

    let p1 = Peer::new(
        true,
        private_keys1,
        Amount::new(100),
        Amount::new(100),
        reward_puzzle_hash1.clone(),
    );

    let private_keys2: ChannelHandlerPrivateKeys = rng.gen();
    let reward_private_key2: PrivateKey = rng.gen();
    let reward_public_key2 = private_to_public_key(&reward_private_key2);
    let reward_puzzle_hash2 = puzzle_hash_for_pk(&mut allocator, &reward_public_key2).expect("should work");

    let p2 = Peer::new(
        false,
        private_keys2,
        Amount::new(100),
        Amount::new(100),
        reward_puzzle_hash2.clone(),
    );

    let parent_coin_id = CoinID::default();
    let parent_coin = CoinString::from_parts(
        &parent_coin_id,
        &reward_puzzle_hash1,
        &Amount::new(200)
    );

    p1.start(parent_coin, &mut pipe_sender[0]).expect("should work");
    // We should have one outbound message.
    assert!(pipe_sender[0].queue.len() == 1);
}
