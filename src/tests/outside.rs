use std::collections::{HashMap, VecDeque};

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

use clvm_tools_rs::compiler::sexp::decode_string;

use crate::common::types::{AllocEncoder, Amount, CoinID, CoinString, Error, PrivateKey, GameID, TransactionBundle, Timeout, PuzzleHash};
use crate::common::standard_coin::{private_to_public_key, puzzle_hash_for_pk};
use crate::outside::{PacketSender, Peer, PeerMessage, WalletSpendInterface, BootstrapTowardWallet, ToLocalUI, PeerEnv};
use crate::channel_handler::types::{ChannelHandlerPrivateKeys, ReadableMove, ChannelHandlerEnv};
use crate::channel_handler::runner::channel_handler_env;

enum NotificationToLocalUI {
    OpponentMoved(GameID, ReadableMove),
    MessageFromOpponent(GameID, ReadableMove),
    GameFinished(GameID, Amount),
    GameCancelled(GameID),
    ShutdownComplete(CoinString),
    GoingOnChain
}

enum WalletBootstrapState {
    PartlySigned(TransactionBundle),
    FullySigned(TransactionBundle)
}

#[derive(Default)]
struct Pipe {
    // PacketSender
    queue: VecDeque<Vec<u8>>,

    // WalletSpendInterface
    outgoing_transactions: VecDeque<TransactionBundle>,
    registered_coins: HashMap<CoinID, Timeout>,

    // Game UI
    game_starts: VecDeque<NotificationToLocalUI>,

    // Bootstrap info
    channel_puzzle_hash: Option<PuzzleHash>,
    bootstrap_state: Option<WalletBootstrapState>,
}

impl PacketSender for Pipe {
    fn send_message(&mut self, msg: &PeerMessage) -> Result<(), Error> {
        let bson_doc = bson::to_bson(&msg).map_err(|e| Error::StrErr(format!("{e:?}")))?;
        let msg_data = bson::to_vec(&bson_doc).map_err(|e| Error::StrErr(format!("{e:?}")))?;
        self.queue.push_back(msg_data);
        Ok(())
    }
}

impl WalletSpendInterface for Pipe {
    fn spend_transaction_and_add_fee(&mut self, bundle: &TransactionBundle) -> Result<(), Error> {
        self.outgoing_transactions.push_back(bundle.clone());

        Ok(())
    }

    fn register_coin(&mut self, coin_id: &CoinID, timeout: &Timeout) -> Result<(), Error> {
        self.registered_coins.insert(coin_id.clone(), timeout.clone());

        Ok(())
    }
}

impl BootstrapTowardWallet for Pipe {
    fn channel_puzzle_hash(&mut self, puzzle_hash: &PuzzleHash) -> Result<(), Error> {
        self.channel_puzzle_hash = Some(puzzle_hash.clone());
        Ok(())
    }

    fn channel_offer(&mut self, bundle: &TransactionBundle) -> Result<(), Error> {
        self.bootstrap_state = Some(WalletBootstrapState::PartlySigned(bundle.clone()));

        Ok(())
    }

    fn channel_transaction_completion(&mut self, bundle: &TransactionBundle) -> Result<(), Error> {
        self.bootstrap_state = Some(WalletBootstrapState::FullySigned(bundle.clone()));

        Ok(())
    }
}

impl ToLocalUI for Pipe {
    fn opponent_moved(&mut self, id: &GameID, readable: ReadableMove) -> Result<(), Error> {
        todo!();
    }
    fn game_message(&mut self, id: &GameID, readable: ReadableMove) -> Result<(), Error> {
        todo!();
    }
    fn game_finished(&mut self, id: &GameID, my_share: Amount) -> Result<(), Error> {
        todo!();
    }
    fn game_cancelled(&mut self, id: &GameID) -> Result<(), Error> {
        todo!();
    }

    fn shutdown_complete(&mut self, reward_coin_string: &CoinString) -> Result<(), Error> {
        todo!();
    }
    fn going_on_chain(&mut self) -> Result<(), Error> {
        todo!();
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

    let mut p1 = Peer::new(
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

    let mut p2 = Peer::new(
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

    let msg1 = pipe_sender[0].queue.pop_front().unwrap();


    {
        let mut env = channel_handler_env(&mut allocator, &mut rng);
        let mut penv = PeerEnv {
            env: &mut env,
            system_interface: &mut pipe_sender[1]
        };
        p2.received_message(&mut penv, msg1).expect("should receive");
    }

    assert!(pipe_sender[1].queue.len() == 1);

    let msg2 = pipe_sender[1].queue.pop_front().unwrap();

    {
        let mut env = channel_handler_env(&mut allocator, &mut rng);
        let mut penv = PeerEnv {
            env: &mut env,
            system_interface: &mut pipe_sender[0]
        };
        p1.received_message(&mut penv, msg2).expect("should receive");
    }
}
