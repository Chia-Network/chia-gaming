use std::collections::{BTreeMap, HashMap, HashSet};

use clvm_traits::ToClvm;
use log::debug;
use rand::prelude::*;
use rand_chacha::ChaCha8Rng;

use clvm_tools_rs::classic::clvm_tools::binutils::disassemble;

use crate::channel_handler::runner::channel_handler_env;
use crate::channel_handler::types::{ChannelHandlerEnv, ChannelHandlerPrivateKeys, ReadableMove};
use crate::common::constants::CREATE_COIN;
use crate::common::standard_coin::{
    agg_sig_me_message, private_to_public_key, puzzle_hash_for_pk, read_hex_puzzle,
    sign_agg_sig_me, solution_for_conditions, standard_solution_partial, ChiaIdentity,
};
use crate::common::types::{
    AllocEncoder, Amount, CoinID, CoinSpend, CoinString, Error, GameID, IntoErr, PrivateKey,
    Program, PuzzleHash, Sha256tree, Spend, SpendBundle, Timeout, ToQuotedProgram,
};
use crate::outside::{
    BootstrapTowardGame, BootstrapTowardWallet, FromLocalUI, GameStart, GameType, PacketSender,
    PeerEnv, PeerMessage, PotatoHandler, SpendWalletReceiver, ToLocalUI, WalletSpendInterface,
};
use crate::peer_container::{FullCoinSetAdapter, MessagePeerQueue, MessagePipe, WatchEntry, WatchReport};

use crate::tests::calpoker::test_moves_1;
use crate::tests::peer::outside::{quiesce, run_move};
use crate::tests::simenv::GameAction;
use crate::tests::simulator::Simulator;

// potato handler tests with simulator.
#[derive(Default)]
struct SimulatedWalletSpend {
    current_height: u64,
    watching_coins: HashMap<CoinString, WatchEntry>,

    outbound_transactions: Vec<Spend>,
    channel_puzzle_hash: Option<PuzzleHash>,
    unfunded_offer: Option<SpendBundle>,
}

impl SimulatedWalletSpend {
    pub fn watch_and_report_coins(
        &mut self,
        current_height: u64,
        current_coins: &WatchReport,
    ) -> Result<WatchReport, Error> {
        self.current_height = current_height;
        let created_coins: HashSet<CoinString> = current_coins
            .created_watched
            .iter()
            .filter(|c| {
                // Report coin if it's being watched.
                self.watching_coins.contains_key(c)
            })
            .cloned()
            .collect();
        let deleted_coins: HashSet<CoinString> = current_coins
            .deleted_watched
            .iter()
            .filter(|c| self.watching_coins.contains_key(c))
            .cloned()
            .collect();

        let mut timeouts = HashSet::new();
        for (k, v) in self.watching_coins.iter_mut() {
            if Timeout::new(current_height as u64) > v.timeout_height {
                // No action on this coin in the timeout.
                timeouts.insert(k.clone());
            }
        }

        for t in timeouts.iter() {
            self.watching_coins.remove(&t);
        }

        Ok(WatchReport {
            created_watched: created_coins,
            deleted_watched: deleted_coins,
            timed_out: timeouts,
        })
    }
}

#[derive(Default)]
struct SimulatedPeer {
    message_pipe: MessagePipe,

    // Bootstrap info
    channel_puzzle_hash: Option<PuzzleHash>,

    simulated_wallet_spend: SimulatedWalletSpend,
}

impl MessagePeerQueue for SimulatedPeer {
    fn message_pipe(&mut self) -> &mut MessagePipe {
        &mut self.message_pipe
    }
    fn get_channel_puzzle_hash(&self) -> Option<PuzzleHash> {
        self.channel_puzzle_hash.clone()
    }
    fn set_channel_puzzle_hash(&mut self, ph: Option<PuzzleHash>) {
        self.channel_puzzle_hash = ph;
    }
    fn get_unfunded_offer(&self) -> Option<SpendBundle> {
        self.simulated_wallet_spend.unfunded_offer.clone()
    }
}

impl SimulatedPeer {
    pub fn watch_and_report_coins(
        &mut self,
        current_height: u64,
        current_coins: &WatchReport
    ) -> Result<WatchReport, Error> {
        self.simulated_wallet_spend
            .watch_and_report_coins(current_height, current_coins)
    }
}

struct SimulatedPeerSystem<'a, 'b: 'a, R: Rng> {
    env: &'b mut ChannelHandlerEnv<'a, R>,
    identity: &'b ChiaIdentity,
    peer: &'b mut SimulatedPeer,
    simulator: &'b mut Simulator,
}

impl PacketSender for SimulatedPeer {
    fn send_message(&mut self, msg: &PeerMessage) -> Result<(), Error> {
        self.message_pipe.send_message(msg)
    }
}

impl WalletSpendInterface for SimulatedWalletSpend {
    /// Enqueue an outbound transaction.
    fn spend_transaction_and_add_fee(&mut self, bundle: &Spend) -> Result<(), Error> {
        debug!("waiting to spend transaction");
        self.outbound_transactions.push(bundle.clone());
        Ok(())
    }

    /// Coin should report its lifecycle until it gets spent, then should be
    /// de-registered.
    fn register_coin(&mut self, coin_id: &CoinString, timeout: &Timeout) -> Result<(), Error> {
        debug!("register coin");
        self.watching_coins.insert(
            coin_id.clone(),
            WatchEntry {
                timeout_height: timeout.clone() + Timeout::new(self.current_height),
            },
        );
        Ok(())
    }
}

impl BootstrapTowardWallet for SimulatedWalletSpend {
    fn channel_puzzle_hash(&mut self, puzzle_hash: &PuzzleHash) -> Result<(), Error> {
        debug!("inner channel puzzle hash");
        self.channel_puzzle_hash = Some(puzzle_hash.clone());
        Ok(())
    }

    fn received_channel_offer(&mut self, bundle: &SpendBundle) -> Result<(), Error> {
        debug!("inner received channel offer");
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
        debug!("spend transaction add fee");
        self.simulated_wallet_spend
            .spend_transaction_and_add_fee(bundle)
    }
    /// Coin should report its lifecycle until it gets spent, then should be
    /// de-registered.
    fn register_coin(&mut self, coin_id: &CoinString, timeout: &Timeout) -> Result<(), Error> {
        debug!("register coin {coin_id:?}");
        self.simulated_wallet_spend.register_coin(coin_id, timeout)
    }
}

impl BootstrapTowardWallet for SimulatedPeer {
    fn channel_puzzle_hash(&mut self, puzzle_hash: &PuzzleHash) -> Result<(), Error> {
        debug!("channel puzzle hash");
        self.simulated_wallet_spend.channel_puzzle_hash(puzzle_hash)
    }

    fn received_channel_offer(&mut self, bundle: &SpendBundle) -> Result<(), Error> {
        debug!("received channel offer");
        self.simulated_wallet_spend.received_channel_offer(bundle)
    }

    fn received_channel_transaction_completion(
        &mut self,
        bundle: &SpendBundle,
    ) -> Result<(), Error> {
        debug!("received channel transaction completion");
        self.simulated_wallet_spend
            .received_channel_transaction_completion(bundle)
    }
}

impl ToLocalUI for SimulatedPeer {
    fn opponent_moved(&mut self, id: &GameID, readable: ReadableMove) -> Result<(), Error> {
        // We can record stuff here and check that we got what was expected, but there's
        // no effect on the game mechanics.
        Ok(())
    }
    fn game_message(&mut self, id: &GameID, readable: &[u8]) -> Result<(), Error> {
        // Record for testing, but doens't affect the game.
        Ok(())
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

impl<'a, 'b: 'a, R> PeerEnv<'a, SimulatedPeer, R> for SimulatedPeerSystem<'a, 'b, R>
where
    R: Rng,
{
    fn env(&mut self) -> (&mut ChannelHandlerEnv<'a, R>, &mut SimulatedPeer) {
        (&mut self.env, &mut self.peer)
    }
}

impl<'a, 'b: 'a, R: Rng> SimulatedPeerSystem<'a, 'b, R> {
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
            simulator,
        }
    }

    /// Check the reported coins vs the current coin set and report changes.
    pub fn update_and_report_coins(
        &mut self,
        coinset_adapter: &mut FullCoinSetAdapter,
        potato_handler: &mut PotatoHandler,
    ) -> Result<WatchReport, Error> {
        let current_height = self.simulator.get_current_height();
        let current_coins = self.simulator.get_all_coins().into_gen()?;
        let coinset_report = coinset_adapter.make_report_from_coin_set_update(
            current_height as u64,
            &current_coins,
        )?;
        let watch_report = self
            .peer
            .watch_and_report_coins(current_height as u64, &coinset_report)?;

        // Report timed out coins
        for t in watch_report.timed_out.iter() {
            debug!("reporting coin timeout: {t:?}");
            potato_handler.coin_timeout_reached(self, t)?;
        }

        // Report deleted coins
        for d in watch_report.deleted_watched.iter() {
            debug!("reporting coin deletion: {d:?}");
            potato_handler.coin_spent(self, d)?;
        }

        // Report created coins
        for c in watch_report.created_watched.iter() {
            debug!("reporting coin creation: {c:?}");
            potato_handler.coin_created(self, c)?;
        }

        Ok(watch_report)
    }

    pub fn farm_block(
        &mut self,
        coinset_adapter: &mut FullCoinSetAdapter,
        potato_handler: &mut PotatoHandler,
        target: &PuzzleHash,
    ) -> Result<WatchReport, Error> {
        self.simulator.farm_block(target);
        self.update_and_report_coins(coinset_adapter, potato_handler)
    }

    /// For each spend in the outbound transaction queue, push it to the blockchain.
    pub fn push_outbound_spends(&mut self) -> Result<(), Error> {
        todo!();
    }

    pub fn run_full_cycle(&mut self) {
        todo!();
    }

    pub fn test_handle_received_channel_puzzle_hash(
        &mut self,
        identity: &ChiaIdentity,
        peer: &mut PotatoHandler,
        parent: &CoinString,
        channel_handler_puzzle_hash: &PuzzleHash,
    ) -> Result<(), Error> {
        let ch = peer.channel_handler()?;
        let channel_coin = ch.state_channel_coin();
        let channel_coin_amt = if let Some((_, _, amt)) = channel_coin.coin_string().to_parts() {
            amt
        } else {
            return Err(Error::StrErr("no channel coin".to_string()));
        };

        let conditions_clvm = [(
            CREATE_COIN,
            (channel_handler_puzzle_hash.clone(), (channel_coin_amt, ())),
        )]
        .to_clvm(self.env.allocator)
        .into_gen()?;

        let spend = standard_solution_partial(
            self.env.allocator,
            &identity.synthetic_private_key,
            &parent.to_coin_id(),
            conditions_clvm,
            &identity.synthetic_public_key,
            &self.env.agg_sig_me_additional_data,
            false,
        )
        .expect("ssp 1");
        let spend_solution_program =
            Program::from_nodeptr(&mut self.env.allocator, spend.solution.clone())?;

        peer.channel_offer(
            self,
            SpendBundle {
                spends: vec![CoinSpend {
                    coin: parent.clone(),
                    bundle: Spend {
                        puzzle: identity.puzzle.clone(),
                        solution: spend_solution_program,
                        signature: spend.signature.clone(),
                    },
                }],
            },
        )
    }
}

fn do_first_game_start<'a, 'b: 'a>(
    env: &'b mut ChannelHandlerEnv<'a, ChaCha8Rng>,
    identity: &'b ChiaIdentity,
    peer: &'b mut SimulatedPeer,
    handler: &'b mut PotatoHandler,
    simulator: &'b mut Simulator,
) -> Vec<GameID> {
    let mut penv = SimulatedPeerSystem::new(env, &identity, peer, simulator);

    let game_ids: Vec<GameID> = handler
        .start_games(
            &mut penv,
            true,
            &GameStart {
                amount: Amount::new(200),
                my_contribution: Amount::new(100),
                game_type: GameType(b"calpoker".to_vec()),
                timeout: Timeout::new(10),
                my_turn: true,
                parameters: vec![0x80],
            },
        )
        .expect("should run");

    game_ids
}

fn do_second_game_start<'a, 'b: 'a>(
    env: &'b mut ChannelHandlerEnv<'a, ChaCha8Rng>,
    identity: &'b ChiaIdentity,
    peer: &'b mut SimulatedPeer,
    handler: &'b mut PotatoHandler,
    simulator: &'b mut Simulator,
) {
    let mut penv = SimulatedPeerSystem::new(env, &identity, peer, simulator);

    handler
        .start_games(
            &mut penv,
            false,
            &GameStart {
                amount: Amount::new(200),
                my_contribution: Amount::new(100),
                game_type: GameType(b"calpoker".to_vec()),
                timeout: Timeout::new(10),
                my_turn: false,
                parameters: vec![0x80],
            },
        )
        .expect("should run");
}

fn check_watch_report<'a, 'b: 'a>(
    env: &'b mut ChannelHandlerEnv<'a, ChaCha8Rng>,
    identity: &'b ChiaIdentity,
    coinset_adapter: &mut FullCoinSetAdapter,
    peer: &'b mut SimulatedPeer,
    handler: &'b mut PotatoHandler,
    simulator: &'b mut Simulator,
) {
    let mut simenv0 = SimulatedPeerSystem::new(env, identity, peer, simulator);

    let watch_report = simenv0
        .farm_block(coinset_adapter, handler, &identity.puzzle_hash)
        .expect("should run");
    debug!("{watch_report:?}");
    let wanted_coin: Vec<CoinString> = watch_report
        .created_watched
        .iter()
        .filter(|a| a.to_parts().unwrap().2 == Amount::new(100))
        .cloned()
        .collect();
    assert_eq!(wanted_coin.len(), 1);
}

pub fn handshake<'a, R: Rng + 'a>(
    rng: &'a mut R,
    allocator: &'a mut AllocEncoder,
    amount: Amount,
    coinset_adapter: &'a mut FullCoinSetAdapter,
    identities: &'a [ChiaIdentity; 2],
    peers: &'a mut [PotatoHandler; 2],
    pipes: &'a mut [SimulatedPeer; 2],
    parent_coins: &[CoinString],
    simulator: &'a mut Simulator,
) -> Result<(), Error> {
    let mut i = 0;
    let mut messages = 0;
    let mut steps = 0;

    while !peers[0].handshake_finished() || !peers[1].handshake_finished() {
        let who = i % 2;
        steps += 1;
        assert!(steps < 50);

        debug!("handshake iterate {who}");
        {
            let mut env = channel_handler_env(allocator, rng);
            if run_move(&mut env, Amount::new(200), pipes, &mut peers[who], who)
                .expect("should send")
            {
                messages += 1;
            }
        }

        if let Some(ph) = pipes[who]
            .simulated_wallet_spend
            .channel_puzzle_hash
            .clone()
        {
            debug!("puzzle hash");
            pipes[who].simulated_wallet_spend.channel_puzzle_hash = None;
            let mut env = channel_handler_env(allocator, rng);
            let mut penv =
                SimulatedPeerSystem::new(&mut env, &identities[who], &mut pipes[who], simulator);
            penv.test_handle_received_channel_puzzle_hash(
                &identities[who],
                &mut peers[who],
                &parent_coins[who],
                &ph,
            )?;
        }

        if let Some(u) = pipes[who].simulated_wallet_spend.unfunded_offer.as_ref() {
            debug!(
                "unfunded offer received by {:?}",
                identities[who].synthetic_private_key
            );
            let mut env = channel_handler_env(allocator, rng);
            let mut spends = u.clone();
            // Create no coins.  The target is already created in the partially funded
            // transaction.
            //
            // XXX break this code out
            let empty_conditions = ().to_clvm(env.allocator).into_gen()?;
            let quoted_empty_conditions = empty_conditions.to_quoted_program(env.allocator)?;
            let solution = solution_for_conditions(env.allocator, empty_conditions)?;
            let quoted_empty_hash = quoted_empty_conditions.sha256tree(env.allocator);
            let signature = sign_agg_sig_me(
                &identities[who].synthetic_private_key,
                &quoted_empty_hash.bytes(),
                &parent_coins[who].to_coin_id(),
                &env.agg_sig_me_additional_data,
            );
            spends.spends.push(CoinSpend {
                coin: parent_coins[who].clone(),
                bundle: Spend {
                    puzzle: identities[who].puzzle.clone(),
                    solution: Program::from_nodeptr(env.allocator, solution)?,
                    signature,
                },
            });
            let included_result = simulator
                .push_tx(env.allocator, &spends.spends)
                .into_gen()?;
            pipes[who].simulated_wallet_spend.unfunded_offer = None;
            debug!("included_result {included_result:?}");
            assert_eq!(included_result.code, 1);

            simulator.farm_block(&identities[who].puzzle_hash);
            simulator.farm_block(&identities[who].puzzle_hash);

            for to_observe in 0..=1 {
                let mut env = channel_handler_env(allocator, rng);
                let mut penv = SimulatedPeerSystem::new(
                    &mut env,
                    &identities[to_observe],
                    &mut pipes[to_observe],
                    simulator,
                );
                debug!("observe coins for peer {to_observe}");
                penv.update_and_report_coins(coinset_adapter, &mut peers[to_observe])?;
            }
        }

        if !pipes[who]
            .simulated_wallet_spend
            .outbound_transactions
            .is_empty()
        {
            debug!(
                "waiting transactions: {:?}",
                pipes[who].simulated_wallet_spend.outbound_transactions
            );
            todo!();
        }

        i += 1;
    }

    Ok(())
}

fn run_calpoker_test_with_action_list(allocator: &mut AllocEncoder, moves: &[GameAction]) {
    let seed_data: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed_data);

    let mut game_type_map = BTreeMap::new();
    let calpoker_factory = read_hex_puzzle(allocator, "clsp/calpoker_include_calpoker_factory.hex")
        .expect("should load");

    game_type_map.insert(
        GameType(b"calpoker".to_vec()),
        calpoker_factory.to_program(),
    );

    let new_peer = |allocator: &mut AllocEncoder, rng: &mut ChaCha8Rng, have_potato: bool| {
        let private_keys1: ChannelHandlerPrivateKeys = rng.gen();
        let reward_private_key1: PrivateKey = rng.gen();
        let reward_public_key1 = private_to_public_key(&reward_private_key1);
        let reward_puzzle_hash1 =
            puzzle_hash_for_pk(allocator, &reward_public_key1).expect("should work");

        PotatoHandler::new(
            have_potato,
            private_keys1,
            game_type_map.clone(),
            Amount::new(100),
            Amount::new(100),
            Timeout::new(1000),
            reward_puzzle_hash1.clone(),
        )
    };

    let ph1 = new_peer(allocator, &mut rng, false);
    let ph2 = new_peer(allocator, &mut rng, true);
    let mut handlers = [ph1, ph2];

    let my_private_key: PrivateKey = rng.gen();
    let their_private_key: PrivateKey = rng.gen();
    let identities = [
        ChiaIdentity::new(allocator, my_private_key).expect("should generate"),
        ChiaIdentity::new(allocator, their_private_key).expect("should generate"),
    ];
    let mut peers = [SimulatedPeer::default(), SimulatedPeer::default()];
    let mut coinset_adapter = FullCoinSetAdapter::default();
    let mut simulator = Simulator::new();

    // Get some coins.
    simulator.farm_block(&identities[0].puzzle_hash);
    simulator.farm_block(&identities[1].puzzle_hash);

    // Get the coins each one owns and test our detection.
    let coins0 = simulator
        .get_my_coins(&identities[0].puzzle_hash)
        .expect("should work");
    let coins1 = simulator
        .get_my_coins(&identities[1].puzzle_hash)
        .expect("should work");
    assert!(!coins1.is_empty());

    // Make a 100 coin for each player (and test the deleted and created events).
    let (parent_coin_0, rest_0) = simulator
        .transfer_coin_amount(
            allocator,
            &identities[0],
            &identities[0],
            &coins0[0],
            Amount::new(100),
        )
        .expect("should work");
    let (parent_coin_1, rest_1) = simulator
        .transfer_coin_amount(
            allocator,
            &identities[1],
            &identities[1],
            &coins1[0],
            Amount::new(100),
        )
        .expect("should work");
    peers[0]
        .register_coin(&parent_coin_0, &Timeout::new(100))
        .expect("should work");

    {
        let mut env = channel_handler_env(allocator, &mut rng);
        check_watch_report(
            &mut env,
            &identities[0],
            &mut coinset_adapter,
            &mut peers[0],
            &mut handlers[1],
            &mut simulator,
        );
    }

    // Farm to make the parent coins.
    simulator.farm_block(&identities[0].puzzle_hash);

    {
        let mut env = channel_handler_env(allocator, &mut rng);
        let mut penv =
            SimulatedPeerSystem::new(&mut env, &identities[1], &mut peers[1], &mut simulator);
        handlers[1]
            .start(&mut penv, parent_coin_1.clone())
            .expect("should work");
    }

    handshake(
        &mut rng,
        allocator,
        Amount::new(100),
        &mut coinset_adapter,
        &identities,
        &mut handlers,
        &mut peers,
        &[parent_coin_0, parent_coin_1],
        &mut simulator,
    )
    .expect("should work");

    quiesce(
        &mut rng,
        allocator,
        Amount::new(200),
        &mut handlers,
        &mut peers,
    )
    .expect("should work");

    // Start game
    let game_ids = {
        let mut env = channel_handler_env(allocator, &mut rng);
        do_first_game_start(
            &mut env,
            &identities[1],
            &mut peers[1],
            &mut handlers[1],
            &mut simulator,
        )
    };

    {
        let mut env = channel_handler_env(allocator, &mut rng);
        do_second_game_start(
            &mut env,
            &identities[0],
            &mut peers[0],
            &mut handlers[0],
            &mut simulator,
        );
    }

    quiesce(
        &mut rng,
        allocator,
        Amount::new(200),
        &mut handlers,
        &mut peers,
    )
    .expect("should work");

    assert!(peers[0].message_pipe.queue.is_empty());
    assert!(peers[1].message_pipe.queue.is_empty());

    for this_move in moves.iter() {
        let (who, what) = if let GameAction::Move(who, what, _) = this_move {
            (who, what)
        } else {
            panic!();
        };

        {
            let mut env = channel_handler_env(allocator, &mut rng);
            let mut penv = SimulatedPeerSystem::new(
                &mut env,
                &identities[who ^ 1],
                &mut peers[who ^ 1],
                &mut simulator,
            );
            handlers[who ^ 1]
                .make_move(&mut penv, &game_ids[0], &ReadableMove::from_nodeptr(*what))
                .expect("should work");
        }

        quiesce(
            &mut rng,
            allocator,
            Amount::new(200),
            &mut handlers,
            &mut peers,
        )
        .expect("should work");
    }
}

#[test]
fn test_peer_in_sim() {
    let mut allocator = AllocEncoder::new();

    // Play moves
    let moves = test_moves_1(&mut allocator);
    run_calpoker_test_with_action_list(&mut allocator, &moves);
}
