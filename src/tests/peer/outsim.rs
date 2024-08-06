use std::collections::{HashMap, HashSet};
use rand::prelude::*;
use rand_chacha::ChaCha8Rng;

use crate::common::types::{AllocEncoder, CoinID, CoinString, Error, IntoErr, Spend, Timeout, PrivateKey, PuzzleHash, SpendBundle};
use crate::common::standard_coin::ChiaIdentity;
use crate::channel_handler::runner::channel_handler_env;
use crate::channel_handler::types::ChannelHandlerEnv;
use crate::outside::{PacketSender, PeerMessage, WalletSpendInterface, BootstrapTowardWallet};
use crate::tests::simulator::Simulator;
use crate::tests::peer::outside::MessagePipe;

// potato handler tests with simulator.
#[derive(Default)]
struct SimulatedWalletSpend {
    watching_coins: HashMap<CoinID, Timeout>,
    current_coins: HashSet<CoinString>,

    outbound_transactions: Vec<Spend>,
    channel_puzzle_hash: Option<PuzzleHash>,
    unfunded_offer: Option<SpendBundle>,
}

#[derive(Default)]
struct SimulatedPeer {
    message_pipe: MessagePipe,

    simulated_wallet_spend: SimulatedWalletSpend,
}

struct SimulatedPeerSystem<'a, R: Rng> {
    env: &'a mut ChannelHandlerEnv<'a, R>,
    identity: &'a ChiaIdentity,
    peer: &'a mut SimulatedPeer,
    simulator: &'a mut Simulator,
}

impl PacketSender for SimulatedPeer {
    fn send_message(&mut self, msg: &PeerMessage) -> Result<(), Error> {
        self.message_pipe.send_message(msg)
    }
}

impl WalletSpendInterface for SimulatedWalletSpend {
    /// Enqueue an outbound transaction.
    fn spend_transaction_and_add_fee(&mut self, bundle: &Spend) -> Result<(), Error> {
        self.outbound_transactions.push(bundle.clone());
        Ok(())
    }

    /// Coin should report its lifecycle until it gets spent, then should be
    /// de-registered.
    fn register_coin(&mut self, coin_id: &CoinID, timeout: &Timeout) -> Result<(), Error> {
        self.watching_coins.insert(coin_id.clone(), timeout.clone());
        Ok(())
    }
}

impl BootstrapTowardWallet for SimulatedWalletSpend {
    fn channel_puzzle_hash(&mut self, puzzle_hash: &PuzzleHash) -> Result<(), Error> {
        self.channel_puzzle_hash = Some(puzzle_hash.clone());
        Ok(())
    }

    fn received_channel_offer(&mut self, bundle: &SpendBundle) -> Result<(), Error> {
        self.unfunded_offer = Some(bundle.clone());
        Ok(())
    }

    fn received_channel_transaction_completion(
        &mut self,
        _bundle: &SpendBundle,
    ) -> Result<(), Error> {
        todo!();
    }
}

impl WalletSpendInterface for SimulatedPeer {
    /// Enqueue an outbound transaction.
    fn spend_transaction_and_add_fee(&mut self, bundle: &Spend) -> Result<(), Error> {
        self.simulated_wallet_spend.spend_transaction_and_add_fee(bundle)
    }
    /// Coin should report its lifecycle until it gets spent, then should be
    /// de-registered.
    fn register_coin(&mut self, coin_id: &CoinID, timeout: &Timeout) -> Result<(), Error> {
        self.simulated_wallet_spend.register_coin(coin_id, timeout)
    }
}

impl BootstrapTowardWallet for SimulatedPeer {
    fn channel_puzzle_hash(&mut self, puzzle_hash: &PuzzleHash) -> Result<(), Error> {
        self.simulated_wallet_spend.channel_puzzle_hash(puzzle_hash)
    }

    fn received_channel_offer(&mut self, bundle: &SpendBundle) -> Result<(), Error> {
        self.simulated_wallet_spend.received_channel_offer(bundle)
    }

    fn received_channel_transaction_completion(
        &mut self,
        bundle: &SpendBundle,
    ) -> Result<(), Error> {
        self.simulated_wallet_spend.received_channel_transaction_completion(bundle)
    }
}

impl<'a, R: Rng> SimulatedPeerSystem<'a, R> {
    pub fn new(
        env: &'a mut ChannelHandlerEnv<'a, R>,
        identity: &'a ChiaIdentity,
        peer: &'a mut SimulatedPeer,
        simulator: &'a mut Simulator,
    ) -> Self {
        SimulatedPeerSystem {
            env,
            identity,
            peer,
            simulator
        }
    }

    /// Check the reported coins vs the current coin set and report changes.
    pub fn watch_and_report_coins(&mut self) -> Result<(), Error> {
        let new_coins = self.simulator.get_all_coins().into_gen()?;
        let mut new_coin_set = HashSet::new();
        std::mem::swap(&mut new_coin_set, &mut self.peer.simulated_wallet_spend.current_coins);
        todo!();
    }

    /// For each spend in the outbound transaction queue, push it to the blockchain.
    pub fn push_outbound_spends(&mut self) -> Result<(), Error> {
        todo!();
    }

    pub fn run_full_cycle(&mut self) {
        todo!();
    }
}

#[test]
fn test_peer_in_sim() {
    let mut allocator = AllocEncoder::new();
    let seed_data: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed_data);
    let my_private_key: PrivateKey = rng.gen();
    let their_private_key: PrivateKey = rng.gen();
    let identities = [
        ChiaIdentity::new(&mut allocator, my_private_key).expect("should generate"),
        ChiaIdentity::new(&mut allocator, their_private_key).expect("should generate"),
    ];
    let mut env = channel_handler_env(&mut allocator, &mut rng);
    let mut peers = [
        SimulatedPeer::default(),
        SimulatedPeer::default()
    ];
    let mut simulator = Simulator::new();
    {
        let simenv0 = SimulatedPeerSystem::new(
            &mut env,
            &identities[0],
            &mut peers[0],
            &mut simulator
        );
    }

    todo!();
}
