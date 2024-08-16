use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

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
use crate::peer_container::{
    report_coin_changes_to_peer, FullCoinSetAdapter, GameCradle, MessagePeerQueue, MessagePipe,
    SynchronousGameCradle, SynchronousGameCradleConfig, WatchEntry, WatchReport,
};

use crate::tests::calpoker::test_moves_1;
use crate::tests::peer::outside::{quiesce, run_move};
use crate::tests::simenv::GameAction;
use crate::tests::simulator::Simulator;

// potato handler tests with simulator.
#[derive(Default)]
struct SimulatedWalletSpend {
    current_height: u64,
    watching_coins: HashMap<CoinString, WatchEntry>,
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

    unfunded_offer: Option<SpendBundle>,
    outbound_transactions: Vec<Spend>,

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
        self.unfunded_offer.clone()
    }
}

impl SimulatedPeer {
    pub fn watch_and_report_coins(
        &mut self,
        current_height: u64,
        current_coins: &WatchReport,
    ) -> Result<WatchReport, Error> {
        self.simulated_wallet_spend
            .watch_and_report_coins(current_height, current_coins)
    }
}

/// Check the reported coins vs the current coin set and report changes.
pub fn update_and_report_coins<'a, 'b, R: Rng>(
    allocator: &mut AllocEncoder,
    rng: &mut R,
    identities: &'a [ChiaIdentity; 2],
    coinset_adapter: &mut FullCoinSetAdapter,
    peers: &mut [PotatoHandler; 2],
    pipes: &'a mut [SimulatedPeer; 2],
    simulator: &'a mut Simulator,
) -> Result<WatchReport, Error> {
    let current_height = simulator.get_current_height();
    let current_coins = simulator.get_all_coins().into_gen()?;
    debug!("current coins {current_height} {current_coins:?}");
    let watch_report =
        coinset_adapter.make_report_from_coin_set_update(current_height as u64, &current_coins)?;
    debug!("coinset adapter result {watch_report:?}");

    // Report timed out coins
    for who in 0..=1 {
        let mut env = channel_handler_env(allocator, rng);
        let mut penv: SimulatedPeerSystem<'_, '_, R> =
            SimulatedPeerSystem::new(&mut env, &identities[who], &mut pipes[who], simulator);

        report_coin_changes_to_peer(&mut penv, &mut peers[who], &watch_report)?;
    }

    Ok(watch_report)
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

impl SimulatedWalletSpend {
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

impl WalletSpendInterface for SimulatedPeer {
    /// Enqueue an outbound transaction.
    fn spend_transaction_and_add_fee(&mut self, bundle: &Spend) -> Result<(), Error> {
        debug!("waiting to spend transaction");
        self.outbound_transactions.push(bundle.clone());
        Ok(())
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
        self.channel_puzzle_hash = Some(puzzle_hash.clone());
        Ok(())
    }

    fn received_channel_offer(&mut self, bundle: &SpendBundle) -> Result<(), Error> {
        debug!("received channel offer");
        self.unfunded_offer = Some(bundle.clone());
        Ok(())
    }

    fn received_channel_transaction_completion(
        &mut self,
        bundle: &SpendBundle,
    ) -> Result<(), Error> {
        debug!("received channel transaction completion");
        todo!();
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

fn check_watch_report<'a, 'b: 'a, R: Rng>(
    allocator: &mut AllocEncoder,
    rng: &mut R,
    identities: &'b [ChiaIdentity; 2],
    coinset_adapter: &mut FullCoinSetAdapter,
    peers: &'b mut [PotatoHandler; 2],
    pipes: &'b mut [SimulatedPeer; 2],
    simulator: &'b mut Simulator,
) {
    let mut env = channel_handler_env(allocator, rng);
    let mut simenv0 = SimulatedPeerSystem::new(&mut env, &identities[0], &mut pipes[0], simulator);
    simulator.farm_block(&identities[0].puzzle_hash);

    let watch_report = update_and_report_coins(
        allocator,
        rng,
        identities,
        coinset_adapter,
        peers,
        pipes,
        simulator,
    )
    .expect("should work");

    debug!("{watch_report:?}");
    let wanted_coin: Vec<CoinString> = watch_report
        .created_watched
        .iter()
        .filter(|a| a.to_parts().unwrap().2 == Amount::new(100))
        .cloned()
        .collect();
    assert_eq!(wanted_coin.len(), 2);
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

        if let Some(ph) = pipes[who].channel_puzzle_hash.clone() {
            debug!("puzzle hash");
            pipes[who].channel_puzzle_hash = None;
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

        if let Some(u) = pipes[who].unfunded_offer.clone() {
            debug!(
                "unfunded offer received by {:?}",
                identities[who].synthetic_private_key
            );

            {
                let mut env = channel_handler_env(allocator, rng);
                let mut penv = SimulatedPeerSystem::new(
                    &mut env,
                    &identities[who],
                    &mut pipes[who],
                    simulator,
                );
                peers[who].channel_transaction_completion(&mut penv, &u)?;
            }

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
            pipes[who].unfunded_offer = None;
            debug!("included_result {included_result:?}");
            assert_eq!(included_result.code, 1);

            simulator.farm_block(&identities[who].puzzle_hash);
            simulator.farm_block(&identities[who].puzzle_hash);

            update_and_report_coins(
                allocator,
                rng,
                identities,
                coinset_adapter,
                peers,
                pipes,
                simulator,
            )?;
        }

        if !pipes[who].outbound_transactions.is_empty() {
            debug!(
                "waiting transactions: {:?}",
                pipes[who].outbound_transactions
            );
            todo!();
        }

        i += 1;
    }

    Ok(())
}

fn poker_collection(allocator: &mut AllocEncoder) -> BTreeMap<GameType, Program> {
    let mut game_type_map = BTreeMap::new();
    let calpoker_factory = read_hex_puzzle(allocator, "clsp/calpoker_include_calpoker_factory.hex")
        .expect("should load");

    game_type_map.insert(
        GameType(b"calpoker".to_vec()),
        calpoker_factory.to_program(),
    );
    game_type_map
}

fn run_calpoker_test_with_action_list(allocator: &mut AllocEncoder, moves: &[GameAction]) {
    let seed_data: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed_data);
    let game_type_map = poker_collection(allocator);

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
            allocator,
            &mut rng,
            &identities,
            &mut coinset_adapter,
            &mut handlers,
            &mut peers,
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

#[derive(Default)]
struct LocalTestUIReceiver {
    shutdown_complete: bool,
    game_finished: Option<Amount>,
    opponent_moved: bool,
}

impl ToLocalUI for LocalTestUIReceiver {
    fn opponent_moved(&mut self, id: &GameID, readable: ReadableMove) -> Result<(), Error> {
        self.opponent_moved = true;
        Ok(())
    }

    fn game_message(&mut self, id: &GameID, readable: &[u8]) -> Result<(), Error> {
        Ok(())
    }

    fn game_finished(&mut self, id: &GameID, my_share: Amount) -> Result<(), Error> {
        self.game_finished = Some(my_share);
        Ok(())
    }

    fn game_cancelled(&mut self, id: &GameID) -> Result<(), Error> {
        todo!();
    }

    fn shutdown_complete(&mut self, reward_coin_string: &CoinString) -> Result<(), Error> {
        self.shutdown_complete = true;
        Ok(())
    }

    fn going_on_chain(&mut self) -> Result<(), Error> {
        todo!();
    }
}

fn run_calpoker_container_with_action_list(allocator: &mut AllocEncoder, moves: &[GameAction]) {
    // Coinset adapter for each side.
    let mut rng = ChaCha8Rng::from_seed([0; 32]);
    let game_type_map = poker_collection(allocator);

    let neutral_pk: PrivateKey = rng.gen();
    let neutral_identity = ChiaIdentity::new(allocator, neutral_pk).expect("should work");

    let pk1: PrivateKey = rng.gen();
    let id1 = ChiaIdentity::new(allocator, pk1).expect("should work");
    let pk2: PrivateKey = rng.gen();
    let id2 = ChiaIdentity::new(allocator, pk2).expect("should work");

    let identities: [ChiaIdentity; 2] = [id1.clone(), id2.clone()];
    let mut coinset_adapter = FullCoinSetAdapter::default();
    let mut local_uis = [
        LocalTestUIReceiver::default(),
        LocalTestUIReceiver::default(),
    ];
    let mut simulator = Simulator::new();

    // Give some money to the users.
    simulator.farm_block(&identities[0].puzzle_hash);
    simulator.farm_block(&identities[1].puzzle_hash);

    let coins0 = simulator
        .get_my_coins(&identities[0].puzzle_hash)
        .expect("should work");
    let coins1 = simulator
        .get_my_coins(&identities[1].puzzle_hash)
        .expect("should work");

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

    simulator.farm_block(&neutral_identity.puzzle_hash);

    let cradle1 = SynchronousGameCradle::new(
        &mut rng,
        SynchronousGameCradleConfig {
            game_types: game_type_map.clone(),
            have_potato: true,
            identity: &identities[0],
            my_contribution: Amount::new(100),
            their_contribution: Amount::new(100),
            channel_timeout: Timeout::new(100),
            reward_puzzle_hash: id1.puzzle_hash.clone(),
        },
    );
    let cradle2 = SynchronousGameCradle::new(
        &mut rng,
        SynchronousGameCradleConfig {
            game_types: game_type_map.clone(),
            have_potato: false,
            identity: &identities[1],
            my_contribution: Amount::new(100),
            their_contribution: Amount::new(100),
            channel_timeout: Timeout::new(100),
            reward_puzzle_hash: id2.puzzle_hash.clone(),
        },
    );
    let mut cradles = [cradle1, cradle2];
    let mut game_ids = Vec::default();
    let mut handshake_done = false;
    let mut can_move = false;

    let mut current_move = moves.iter();
    let mut last_move = 0;
    let mut num_steps = 0;

    // Give coins to the cradles.
    cradles[0]
        .opening_coin(allocator, &mut rng, parent_coin_0)
        .expect("should work");
    cradles[1]
        .opening_coin(allocator, &mut rng, parent_coin_1)
        .expect("should work");

    // XXX Move on to shutdown complete.
    while !local_uis.iter().all(|l| l.game_finished.is_some()) {
        num_steps += 1;

        assert!(num_steps < 100);

        simulator.farm_block(&neutral_identity.puzzle_hash);
        let current_height = simulator.get_current_height();
        let current_coins = simulator.get_all_coins().expect("should work");
        debug!("current coins {current_height} {current_coins:?}");
        let watch_report = coinset_adapter
            .make_report_from_coin_set_update(current_height as u64, &current_coins)
            .expect("should work");

        for i in 0..=1 {
            cradles[i]
                .new_block(allocator, &mut rng, current_height, &watch_report)
                .expect("should work");

            loop {
                let result = cradles[i]
                    .idle(allocator, &mut rng, &mut local_uis[i])
                    .expect("should work");
                debug!(
                    "cradle {i}: continue_on {} outbound {}",
                    result.continue_on,
                    result.outbound_messages.len()
                );

                for tx in result.outbound_transactions.iter() {
                    let included_result = simulator
                        .push_tx(allocator, &tx.spends)
                        .expect("should work");
                    debug!("included_result {included_result:?}");
                    assert_eq!(included_result.code, 1);
                }

                for msg in result.outbound_messages.iter() {
                    cradles[i ^ 1].deliver_message(&msg).expect("should work");
                }

                if !result.continue_on {
                    break;
                }
            }
        }

        if !handshake_done && cradles[0].handshake_finished() && cradles[1].handshake_finished() {
            // Start game.
            handshake_done = true;

            game_ids = cradles[0]
                .start_games(
                    allocator,
                    &mut rng,
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

            cradles[1]
                .start_games(
                    allocator,
                    &mut rng,
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

            can_move = true;
        } else if can_move || local_uis.iter().any(|l| l.opponent_moved) {
            can_move = false;
            assert!(!game_ids.is_empty());

            // Reset moved flags.
            for l in local_uis.iter_mut() {
                l.opponent_moved = false;
            }

            if let Some(ga) = current_move.next() {
                match ga {
                    GameAction::Move(who, readable, _) => {
                        last_move = *who;
                        debug!("make move");
                        let readable_program =
                            Program::from_nodeptr(allocator, *readable).expect("should convert");
                        let encoded_readable_move = readable_program.bytes();
                        cradles[*who]
                            .make_move(
                                allocator,
                                &mut rng,
                                &game_ids[0],
                                encoded_readable_move.to_vec(),
                            )
                            .expect("should work");
                    }
                    _ => todo!(),
                }
            } else {
                cradles[last_move ^ 1]
                    .accept(allocator, &mut rng, &game_ids[0])
                    .expect("should work");
            }
        }
    }
}

#[test]
fn sim_test_with_peer_container() {
    let mut allocator = AllocEncoder::new();

    // Play moves
    let moves = test_moves_1(&mut allocator);
    run_calpoker_container_with_action_list(&mut allocator, &moves);
}
