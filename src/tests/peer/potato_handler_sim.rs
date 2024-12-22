use std::collections::HashMap;
use std::rc::Rc;

use clvm_tools_rs::classic::clvm_tools::binutils::disassemble;

use clvm_traits::{ClvmEncoder, ToClvm};
use log::debug;
use rand::prelude::*;
use rand_chacha::ChaCha8Rng;

use crate::channel_handler::runner::channel_handler_env;
use crate::channel_handler::types::{ChannelHandlerEnv, ChannelHandlerPrivateKeys, ReadableMove};
use crate::common::constants::CREATE_COIN;
use crate::common::standard_coin::{
    private_to_public_key, puzzle_hash_for_pk, sign_agg_sig_me, solution_for_conditions,
    standard_solution_partial, ChiaIdentity,
};
use crate::common::types::{
    AllocEncoder, Amount, CoinSpend, CoinString, Error, GameID, IntoErr, PrivateKey, Program,
    PuzzleHash, Sha256tree, Spend, SpendBundle, Timeout, ToQuotedProgram,
};
use crate::games::calpoker::decode_calpoker_readable;
use crate::games::poker_collection;
use crate::peer_container::{
    report_coin_changes_to_peer, FullCoinSetAdapter, GameCradle, MessagePeerQueue, MessagePipe,
    SynchronousGameCradle, SynchronousGameCradleConfig, WatchEntry, WatchReport,
};
use crate::potato_handler::{
    BootstrapTowardGame, BootstrapTowardWallet, FromLocalUI, GameStart, GameType, PacketSender,
    PeerEnv, PeerMessage, PotatoHandler, PotatoHandlerInit, ToLocalUI, WalletSpendInterface,
};

use crate::simulator::Simulator;
use crate::tests::calpoker::test_moves_1;
use crate::tests::game::GameAction;
use crate::tests::peer::potato_handler::{quiesce, run_move};

// potato handler tests with simulator.
#[derive(Default)]
struct SimulatedWalletSpend {
    current_height: u64,
    watching_coins: HashMap<CoinString, WatchEntry>,
}

#[derive(Default)]
pub struct SimulatedPeer {
    message_pipe: MessagePipe,

    // Bootstrap info
    channel_puzzle_hash: Option<PuzzleHash>,

    unfunded_offer: Option<SpendBundle>,
    outbound_transactions: Vec<SpendBundle>,

    raw_messages: Vec<Vec<u8>>,
    messages: Vec<ReadableMove>,

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

/// Check the reported coins vs the current coin set and report changes.
pub fn update_and_report_coins<'a, R: Rng>(
    allocator: &mut AllocEncoder,
    rng: &mut R,
    coinset_adapter: &mut FullCoinSetAdapter,
    peers: &mut [PotatoHandler; 2],
    pipes: &'a mut [SimulatedPeer; 2],
    simulator: &'a mut Simulator,
) -> Result<WatchReport, Error> {
    let current_height = simulator.get_current_height();
    let current_coins = simulator.get_all_coins().into_gen()?;
    let watch_report =
        coinset_adapter.make_report_from_coin_set_update(current_height as u64, &current_coins)?;

    // Report timed out coins
    for who in 0..=1 {
        let mut env = channel_handler_env(allocator, rng);
        let mut penv: SimulatedPeerSystem<'_, '_, R> =
            SimulatedPeerSystem::new(&mut env, &mut pipes[who]);

        report_coin_changes_to_peer(&mut penv, &mut peers[who], &watch_report)?;
    }

    Ok(watch_report)
}

struct SimulatedPeerSystem<'a, 'b: 'a, R: Rng> {
    env: &'b mut ChannelHandlerEnv<'a, R>,
    // identity: &'b ChiaIdentity,
    peer: &'b mut SimulatedPeer,
    // simulator: &'b mut Simulator,
}

impl PacketSender for SimulatedPeer {
    fn send_message(&mut self, msg: &PeerMessage) -> Result<(), Error> {
        self.message_pipe.send_message(msg)
    }
}

impl SimulatedWalletSpend {
    /// Coin should report its lifecycle until it gets spent, then should be
    /// de-registered.
    fn register_coin(
        &mut self,
        coin_id: &CoinString,
        timeout: &Timeout,
        name: Option<&'static str>,
    ) -> Result<(), Error> {
        debug!("register coin {name:?}");
        self.watching_coins.insert(
            coin_id.clone(),
            WatchEntry {
                timeout_blocks: timeout.clone(),
                timeout_at: Some(timeout.to_u64() + self.current_height),
                name,
            },
        );
        Ok(())
    }
}

impl WalletSpendInterface for SimulatedPeer {
    /// Enqueue an outbound transaction.
    fn spend_transaction_and_add_fee(&mut self, bundle: &SpendBundle) -> Result<(), Error> {
        debug!("waiting to spend transaction");
        self.outbound_transactions.push(bundle.clone());
        Ok(())
    }
    /// Coin should report its lifecycle until it gets spent, then should be
    /// de-registered.
    fn register_coin(
        &mut self,
        coin_id: &CoinString,
        timeout: &Timeout,
        name: Option<&'static str>,
    ) -> Result<(), Error> {
        debug!("register coin {coin_id:?}");
        self.simulated_wallet_spend
            .register_coin(coin_id, timeout, name)
    }

    fn request_puzzle_and_solution(&mut self, _coin_id: &CoinString) -> Result<(), Error> {
        todo!();
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
        _bundle: &SpendBundle,
    ) -> Result<(), Error> {
        debug!("received channel transaction completion");
        todo!();
    }
}

impl ToLocalUI for SimulatedPeer {
    fn opponent_moved(
        &mut self,
        _allocator: &mut AllocEncoder,
        _id: &GameID,
        _readable: ReadableMove,
        _my_share: Amount,
    ) -> Result<(), Error> {
        // We can record stuff here and check that we got what was expected, but there's
        // no effect on the game mechanics.
        Ok(())
    }
    fn raw_game_message(&mut self, _id: &GameID, readable: &[u8]) -> Result<(), Error> {
        self.raw_messages.push(readable.to_vec());
        Ok(())
    }
    fn game_message(
        &mut self,
        _allocator: &mut AllocEncoder,
        _id: &GameID,
        readable: ReadableMove,
    ) -> Result<(), Error> {
        // Record for testing, but doens't affect the game.
        self.messages.push(readable);
        Ok(())
    }
    fn game_finished(&mut self, _id: &GameID, _my_share: Amount) -> Result<(), Error> {
        todo!();
    }
    fn game_cancelled(&mut self, _id: &GameID) -> Result<(), Error> {
        todo!();
    }
    fn shutdown_complete(&mut self, _reward_coin_string: Option<&CoinString>) -> Result<(), Error> {
        todo!();
    }
    fn going_on_chain(&mut self, _got_error: bool) -> Result<(), Error> {
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
    pub fn new(env: &'a mut ChannelHandlerEnv<'a, R>, peer: &'a mut SimulatedPeer) -> Self {
        SimulatedPeerSystem {
            env,
            // identity,
            peer,
            // simulator,
        }
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

        peer.channel_offer(
            self,
            SpendBundle {
                name: None,
                spends: vec![CoinSpend {
                    coin: parent.clone(),
                    bundle: Spend {
                        puzzle: identity.puzzle.clone(),
                        solution: spend.solution.clone(),
                        signature: spend.signature.clone(),
                    },
                }],
            },
        )
    }
}

fn do_first_game_start<'a, 'b: 'a>(
    env: &'b mut ChannelHandlerEnv<'a, ChaCha8Rng>,
    peer: &'b mut SimulatedPeer,
    handler: &'b mut PotatoHandler,
) -> Vec<GameID> {
    let mut penv = SimulatedPeerSystem::new(env, peer);

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
    peer: &'b mut SimulatedPeer,
    handler: &'b mut PotatoHandler,
) {
    let mut penv = SimulatedPeerSystem::new(env, peer);

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
    let mut _simenv0 = SimulatedPeerSystem::new(&mut env, &mut pipes[0]);
    simulator.farm_block(&identities[0].puzzle_hash);

    let watch_report =
        update_and_report_coins(allocator, rng, coinset_adapter, peers, pipes, simulator)
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

#[allow(clippy::too_many_arguments)]
pub fn handshake<'a, R: Rng + 'a>(
    rng: &'a mut R,
    allocator: &'a mut AllocEncoder,
    _amount: Amount,
    coinset_adapter: &'a mut FullCoinSetAdapter,
    identities: &'a [ChiaIdentity; 2],
    peers: &'a mut [PotatoHandler; 2],
    pipes: &'a mut [SimulatedPeer; 2],
    parent_coins: &[CoinString],
    simulator: &'a mut Simulator,
) -> Result<(), Error> {
    let mut i = 0;
    let mut steps = 0;

    while !peers[0].handshake_finished() || !peers[1].handshake_finished() {
        let who = i % 2;
        steps += 1;
        assert!(steps < 50);

        debug!("handshake iterate {who}");
        {
            let mut env = channel_handler_env(allocator, rng);
            run_move(&mut env, Amount::new(200), pipes, &mut peers[who], who).expect("should send");
        }

        if let Some(ph) = pipes[who].channel_puzzle_hash.clone() {
            debug!("puzzle hash");
            pipes[who].channel_puzzle_hash = None;
            let mut env = channel_handler_env(allocator, rng);
            let mut penv = SimulatedPeerSystem::new(&mut env, &mut pipes[who]);
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
                let mut penv = SimulatedPeerSystem::new(&mut env, &mut pipes[who]);
                peers[who].channel_transaction_completion(&mut penv, &u)?;
            }

            let env = channel_handler_env(allocator, rng);
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
                quoted_empty_hash.bytes(),
                &parent_coins[who].to_coin_id(),
                &env.agg_sig_me_additional_data,
            );
            spends.spends.push(CoinSpend {
                coin: parent_coins[who].clone(),
                bundle: Spend {
                    puzzle: identities[who].puzzle.clone(),
                    solution: Rc::new(Program::from_nodeptr(env.allocator, solution)?),
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

            update_and_report_coins(allocator, rng, coinset_adapter, peers, pipes, simulator)?;
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

        PotatoHandler::new(PotatoHandlerInit {
            have_potato,
            private_keys: private_keys1,
            game_types: game_type_map.clone(),
            my_contribution: Amount::new(100),
            their_contribution: Amount::new(100),
            channel_timeout: Timeout::new(1000),
            unroll_timeout: Timeout::new(5),
            reward_puzzle_hash: reward_puzzle_hash1.clone(),
        })
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
    let mut simulator = Simulator::default();

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
    let (parent_coin_0, _rest_0) = simulator
        .transfer_coin_amount(
            allocator,
            &identities[0],
            &identities[0],
            &coins0[0],
            Amount::new(100),
        )
        .expect("should work");
    let (parent_coin_1, _rest_1) = simulator
        .transfer_coin_amount(
            allocator,
            &identities[1],
            &identities[1],
            &coins1[0],
            Amount::new(100),
        )
        .expect("should work");
    peers[0]
        .register_coin(&parent_coin_0, &Timeout::new(100), Some("parent"))
        .expect("should work");

    {
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
        let mut penv = SimulatedPeerSystem::new(&mut env, &mut peers[1]);
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
        do_first_game_start(&mut env, &mut peers[1], &mut handlers[1])
    };

    {
        let mut env = channel_handler_env(allocator, &mut rng);
        do_second_game_start(&mut env, &mut peers[0], &mut handlers[0]);
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
            let entropy = rng.gen();
            let mut env = channel_handler_env(allocator, &mut rng);
            let move_readable =
                ReadableMove::from_nodeptr(env.allocator, *what).expect("should work");
            let mut penv = SimulatedPeerSystem::new(&mut env, &mut peers[who ^ 1]);
            handlers[who ^ 1]
                .make_move(&mut penv, &game_ids[0], &move_readable, entropy)
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
    go_on_chain: bool,
    got_error: bool,
    opponent_moves: Vec<(GameID, ReadableMove, Amount)>,
}

impl ToLocalUI for LocalTestUIReceiver {
    fn opponent_moved(
        &mut self,
        _allocator: &mut AllocEncoder,
        id: &GameID,
        readable: ReadableMove,
        my_share: Amount,
    ) -> Result<(), Error> {
        self.opponent_moved = true;
        self.opponent_moves.push((id.clone(), readable, my_share));
        Ok(())
    }

    fn game_message(
        &mut self,
        _allocator: &mut AllocEncoder,
        _id: &GameID,
        _readable: ReadableMove,
    ) -> Result<(), Error> {
        Ok(())
    }

    fn game_finished(&mut self, _id: &GameID, my_share: Amount) -> Result<(), Error> {
        self.game_finished = Some(my_share);
        Ok(())
    }

    fn game_cancelled(&mut self, _id: &GameID) -> Result<(), Error> {
        todo!();
    }

    fn shutdown_complete(&mut self, _reward_coin_string: Option<&CoinString>) -> Result<(), Error> {
        todo!();
        self.shutdown_complete = true;
        Ok(())
    }

    fn going_on_chain(&mut self, got_error: bool) -> Result<(), Error> {
        self.go_on_chain = true;
        self.got_error = got_error;
        Ok(())
    }
}

type GameRunEarlySuccessPredicate<'a> = Option<&'a dyn Fn(&[SynchronousGameCradle]) -> bool>;

struct CalpokerRunOutcome {
    identities: [ChiaIdentity; 2],
    cradles: [SynchronousGameCradle; 2],
    local_uis: [LocalTestUIReceiver; 2],
    simulator: Simulator,
}

fn run_calpoker_container_with_action_list_with_success_predicate(
    allocator: &mut AllocEncoder,
    moves: &[GameAction],
    pred: GameRunEarlySuccessPredicate,
) -> Result<CalpokerRunOutcome, Error> {
    // Coinset adapter for each side.
    let mut rng = ChaCha8Rng::from_seed([0; 32]);
    let game_type_map = poker_collection(allocator);

    let neutral_pk: PrivateKey = rng.gen();
    let neutral_identity = ChiaIdentity::new(allocator, neutral_pk)?;

    let pk1: PrivateKey = rng.gen();
    let id1 = ChiaIdentity::new(allocator, pk1)?;
    let pk2: PrivateKey = rng.gen();
    let id2 = ChiaIdentity::new(allocator, pk2)?;

    let identities: [ChiaIdentity; 2] = [id1.clone(), id2.clone()];
    let mut coinset_adapter = FullCoinSetAdapter::default();
    let mut local_uis = [
        LocalTestUIReceiver::default(),
        LocalTestUIReceiver::default(),
    ];
    let simulator = Simulator::default();

    // Give some money to the users.
    simulator.farm_block(&identities[0].puzzle_hash);
    simulator.farm_block(&identities[1].puzzle_hash);

    let coins0 = simulator
        .get_my_coins(&identities[0].puzzle_hash)
        .into_gen()?;
    let coins1 = simulator
        .get_my_coins(&identities[1].puzzle_hash)
        .into_gen()?;

    // Make a 100 coin for each player (and test the deleted and created events).
    let (parent_coin_0, _rest_0) = simulator.transfer_coin_amount(
        allocator,
        &identities[0],
        &identities[0],
        &coins0[0],
        Amount::new(100),
    )?;
    let (parent_coin_1, _rest_1) = simulator.transfer_coin_amount(
        allocator,
        &identities[1],
        &identities[1],
        &coins1[0],
        Amount::new(100),
    )?;

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
            unroll_timeout: Timeout::new(5),
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
            unroll_timeout: Timeout::new(5),
            reward_puzzle_hash: id2.puzzle_hash.clone(),
        },
    );
    let mut cradles = [cradle1, cradle2];
    let mut game_ids = Vec::default();
    let mut handshake_done = false;
    let mut can_move = false;
    let mut ending = None;

    let mut current_move = moves.iter();
    let mut num_steps = 0;

    // Give coins to the cradles.
    cradles[0].opening_coin(allocator, &mut rng, parent_coin_0)?;
    cradles[1].opening_coin(allocator, &mut rng, parent_coin_1)?;

    while !matches!(ending, Some(0)) {
        num_steps += 1;

        assert!(num_steps < 1000);

        simulator.farm_block(&neutral_identity.puzzle_hash);
        let current_height = simulator.get_current_height();
        let current_coins = simulator.get_all_coins().expect("should work");
        let watch_report = coinset_adapter
            .make_report_from_coin_set_update(current_height as u64, &current_coins)?;

        if let Some(p) = &pred {
            if p(&cradles) {
                // Success.
                return Ok(CalpokerRunOutcome {
                    identities,
                    cradles,
                    local_uis,
                    simulator,
                });
            }
        }

        for i in 0..=1 {
            if cradles[i].handshake_finished() {
                let reward_ph = cradles[i].get_reward_puzzle_hash(allocator, &mut rng)?;
                let reward_coins = simulator.get_my_coins(&reward_ph).into_gen()?;
                debug!("{i} reward coins {reward_coins:?}");
                // Spend the reward coin to the player.
                if !reward_coins.is_empty() {
                    let spends = cradles[i].spend_reward_coins(
                        allocator,
                        &mut rng,
                        &reward_coins,
                        &identities[i].puzzle_hash,
                    )?;
                    let included = simulator
                        .push_tx(allocator, &spends.coins_with_solutions)
                        .into_gen()?;
                    debug!("reward spends: {included:?}");
                    assert_eq!(included.code, 1);
                }
            }

            if local_uis[i].go_on_chain {
                // Perform on chain move.
                // Turn off the flag to go on chain.
                local_uis[i].go_on_chain = false;
                let got_error = local_uis[i].got_error;
                cradles[i].go_on_chain(allocator, &mut rng, &mut local_uis[i], got_error)?;
            }

            cradles[i].new_block(allocator, &mut rng, current_height, &watch_report)?;

            loop {
                let result = if let Some(result) =
                    cradles[i].idle(allocator, &mut rng, &mut local_uis[i])?
                {
                    result
                } else {
                    break;
                };

                for coin in result.coin_solution_requests.iter() {
                    let ps_res = simulator
                        .get_puzzle_and_solution(coin)
                        .expect("should work");
                    for cradle in cradles.iter_mut() {
                        cradle.report_puzzle_and_solution(
                            allocator,
                            &mut rng,
                            coin,
                            ps_res.as_ref().map(|ps| (&ps.0, &ps.1)),
                        )?;
                    }
                }

                for tx in result.outbound_transactions.iter() {
                    debug!("PROCESS TX {tx:?}");
                    let included_result = simulator.push_tx(allocator, &tx.spends).into_gen()?;
                    debug!("included_result {included_result:?}");
                    assert_eq!(included_result.code, 1);
                }

                for msg in result.outbound_messages.iter() {
                    cradles[i ^ 1].deliver_message(msg)?;
                }

                if !result.continue_on {
                    break;
                }
            }
        }

        let should_end = cradles.iter().all(|c| c.finished()) && ending.is_none();
        if should_end {
            ending = Some(10);
        }

        if let Some(ending) = &mut ending {
            *ending -= 1;
        }

        if !handshake_done && cradles[0].handshake_finished() && cradles[1].handshake_finished() {
            // Start game.
            handshake_done = true;

            game_ids = cradles[0].start_games(
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
            )?;

            cradles[1].start_games(
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
            )?;

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
                        debug!("make move");
                        let readable_program = Program::from_nodeptr(allocator, *readable)?;
                        let encoded_readable_move = readable_program.bytes();
                        let entropy = rng.gen();
                        cradles[*who].make_move(
                            allocator,
                            &mut rng,
                            &game_ids[0],
                            encoded_readable_move.to_vec(),
                            entropy,
                        )?;
                    }
                    GameAction::GoOnChain(_who) => {
                        debug!("go on chain");
                        todo!();
                    }
                    GameAction::FakeMove(who, readable, move_data) => {
                        // This is a fake move.  We give that move to the given target channel
                        // handler as a their move.
                        debug!("make move");
                        let readable_program = Program::from_nodeptr(allocator, *readable)?;
                        let encoded_readable_move = readable_program.bytes();
                        let entropy = rng.gen();
                        // Do like we're sending a real message.
                        cradles[*who].make_move(
                            allocator,
                            &mut rng,
                            &game_ids[0],
                            encoded_readable_move.to_vec(),
                            entropy,
                        )?;

                        cradles[*who].replace_last_message(|msg_envelope| {
                            debug!("sabotage envelope = {msg_envelope:?}");
                            let (game_id, m) = if let PeerMessage::Move(game_id, m) = msg_envelope {
                                (game_id, m)
                            } else {
                                todo!();
                            };

                            let mut fake_move = m.clone();
                            fake_move
                                .game_move
                                .basic
                                .move_made
                                .append(&mut move_data.clone());
                            Ok(PeerMessage::Move(game_id.clone(), fake_move))
                        })?;
                    }
                    GameAction::Accept(who) | GameAction::Timeout(who) => {
                        debug!("{who} doing ACCEPT");
                        can_move = true;
                        cradles[*who].accept(allocator, &mut rng, &game_ids[0])?;
                    }
                    GameAction::Shutdown(who, _) => {
                        can_move = true;
                        cradles[*who].shut_down(allocator, &mut rng)?;
                    }
                }
            }
        }
    }

    Ok(CalpokerRunOutcome {
        identities,
        cradles,
        local_uis,
        simulator,
    })
}

fn run_calpoker_container_with_action_list(
    allocator: &mut AllocEncoder,
    moves: &[GameAction],
) -> Result<CalpokerRunOutcome, Error> {
    run_calpoker_container_with_action_list_with_success_predicate(allocator, moves, None)
}

#[test]
fn sim_test_with_peer_container_piss_off_peer_basic_on_chain() {
    let mut allocator = AllocEncoder::new();

    let mut moves = test_moves_1(&mut allocator).to_vec();
    if let GameAction::Move(player, readable, _) = moves[3].clone() {
        moves.insert(3, GameAction::FakeMove(player, readable, vec![0; 500]));
    } else {
        panic!("no move 1 to replace");
    }
    run_calpoker_container_with_action_list_with_success_predicate(
        &mut allocator,
        &moves,
        Some(&|cradles| cradles[0].is_on_chain() && cradles[1].is_on_chain()),
    )
    .expect("should finish");
}

#[test]
fn sim_test_with_peer_container_piss_off_peer_complete() {
    let mut allocator = AllocEncoder::new();

    let mut moves = test_moves_1(&mut allocator).to_vec();
    let nil = allocator.encode_atom(&[]).into_gen().expect("should work");
    moves.push(GameAction::Accept(0));
    moves.push(GameAction::Accept(1));
    moves.push(GameAction::Shutdown(0, nil));
    moves.push(GameAction::Shutdown(1, nil));
    if let GameAction::Move(player, readable, _) = moves[3].clone() {
        moves.insert(3, GameAction::FakeMove(player, readable, vec![0; 500]));
    } else {
        panic!("no move 1 to replace");
    }
    let outcome =
        run_calpoker_container_with_action_list(&mut allocator, &moves).expect("should finish");
    let p1_ph = outcome.identities[0].puzzle_hash.clone();
    let p2_ph = outcome.identities[1].puzzle_hash.clone();
    let p1_coins = outcome.simulator.get_my_coins(&p1_ph).expect("should work");
    let p2_coins = outcome.simulator.get_my_coins(&p2_ph).expect("should work");
    let p1_balance: u64 = p1_coins
        .iter()
        .map(|c| c.to_parts().map(|(_, _, amt)| amt.to_u64()).unwrap_or(0))
        .sum();
    let p2_balance: u64 = p2_coins
        .iter()
        .map(|c| c.to_parts().map(|(_, _, amt)| amt.to_u64()).unwrap_or(0))
        .sum();
    for (pn, lui) in outcome.local_uis.iter().enumerate() {
        for the_move in lui.opponent_moves.iter() {
            let the_move_to_node = the_move.1.to_nodeptr(&mut allocator).expect("should work");
            debug!(
                "player {pn} opponent move {the_move:?} {}",
                disassemble(allocator.allocator(), the_move_to_node, None)
            );
        }
    }
    let outcome_move = &outcome.local_uis[0].opponent_moves[2];
    let outcome_node = outcome_move
        .1
        .to_nodeptr(&mut allocator)
        .expect("should work");
    let decoded_outcome =
        decode_calpoker_readable(&mut allocator, outcome_node, Amount::new(200), false)
            .expect("should decode");
    debug!(
        "outcome move {}",
        disassemble(allocator.allocator(), outcome_node, None)
    );
    debug!("game outcome {decoded_outcome:?}");
    debug!("p1 balance {p1_balance:?} p2 {p2_balance:?}");
    if decoded_outcome.win_direction == 1 {
        assert_eq!(p2_balance + 200, p1_balance);
    } else if decoded_outcome.win_direction == -1 {
        assert_eq!(p2_balance, p1_balance + 200);
    } else {
        assert_eq!(p2_balance, p1_balance);
    }
}
