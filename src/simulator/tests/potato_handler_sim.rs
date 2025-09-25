use std::borrow::Borrow;
use std::collections::HashMap;
use std::rc::Rc;

use clvm_traits::ToClvm;
use log::debug;
use rand::prelude::*;
use rand_chacha::ChaCha8Rng;

use crate::channel_handler::runner::channel_handler_env;
use crate::channel_handler::types::{
    ChannelHandlerEnv, ChannelHandlerPrivateKeys, GameStartFailed, ReadableMove,
};
use crate::common::constants::CREATE_COIN;
use crate::common::standard_coin::{
    private_to_public_key, puzzle_hash_for_pk, sign_agg_sig_me, solution_for_conditions,
    standard_solution_partial, ChiaIdentity,
};
use crate::common::types::{
    AllocEncoder, Amount, CoinSpend, CoinString, Error, GameID, IntoErr, Node, PrivateKey, Program,
    PuzzleHash, Sha256tree, Spend, SpendBundle, Timeout, ToQuotedProgram,
};
use crate::games::calpoker::{
    decode_calpoker_readable, decode_readable_card_choices, get_final_used_cards,
};
use crate::games::poker_collection;
use crate::peer_container::{
    report_coin_changes_to_peer, FullCoinSetAdapter, GameCradle, GameStartRecord, MessagePeerQueue,
    MessagePipe, SynchronousGameCradle, SynchronousGameCradleConfig, WatchEntry, WatchReport,
};
use crate::potato_handler::types::{
    BootstrapTowardGame, BootstrapTowardWallet, FromLocalUI, GameStart, GameType, PacketSender,
    PeerEnv, PeerMessage, PotatoHandlerInit, ToLocalUI, WalletSpendInterface,
};
use crate::potato_handler::PotatoHandler;

use crate::shutdown::BasicShutdownConditions;
use crate::simulator::Simulator;
use crate::test_support::calpoker::prefix_test_moves;
use crate::test_support::debug_game::{
    make_debug_games, BareDebugGameDriver, DebugGameCurry, DebugGameMoveInfo,
};
use crate::test_support::game::GameAction;
use crate::test_support::peer::potato_handler::{quiesce, run_move};
use crate::utils::pair_of_array_mut;

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
        let mut env = channel_handler_env(allocator, rng).expect("should work");
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
        _state_number: usize,
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
    fn game_start(
        &mut self,
        _ids: &[GameID],
        _failed: Option<GameStartFailed>,
    ) -> Result<(), Error> {
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
    v1: bool,
) -> Vec<GameID> {
    let mut penv = SimulatedPeerSystem::new(env, peer);
    let nil = Program::from_hex("80").unwrap();
    let type_id = if v1 { b"ca1poker" } else { b"calpoker" };

    let game_id = handler.next_game_id().unwrap();
    let game_ids: Vec<GameID> = handler
        .start_games(
            &mut penv,
            true,
            &GameStart {
                game_id,
                amount: Amount::new(200),
                my_contribution: Amount::new(100),
                game_type: GameType(type_id.to_vec()),
                timeout: Timeout::new(25),
                my_turn: true,
                parameters: nil.clone(),
            },
        )
        .expect("should run");

    game_ids
}

fn do_second_game_start<'a, 'b: 'a>(
    env: &'b mut ChannelHandlerEnv<'a, ChaCha8Rng>,
    peer: &'b mut SimulatedPeer,
    handler: &'b mut PotatoHandler,
    v1: bool,
) {
    let mut penv = SimulatedPeerSystem::new(env, peer);
    let nil = Program::from_hex("80").unwrap();
    let type_id = if v1 { b"ca1poker" } else { b"calpoker" };

    let game_id = handler.next_game_id().unwrap();
    handler
        .start_games(
            &mut penv,
            false,
            &GameStart {
                game_id,
                amount: Amount::new(200),
                my_contribution: Amount::new(100),
                game_type: GameType(type_id.to_vec()),
                timeout: Timeout::new(25),
                my_turn: false,
                parameters: nil.clone(),
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
    let mut env = channel_handler_env(allocator, rng).expect("should work");
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
            let mut env = channel_handler_env(allocator, rng).expect("should work");
            run_move(&mut env, Amount::new(200), pipes, &mut peers[who], who).expect("should send");
        }

        if let Some(ph) = pipes[who].channel_puzzle_hash.clone() {
            debug!("puzzle hash");
            pipes[who].channel_puzzle_hash = None;
            let mut env = channel_handler_env(allocator, rng).expect("should work");
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
                let mut env = channel_handler_env(allocator, rng).expect("should work");
                let mut penv = SimulatedPeerSystem::new(&mut env, &mut pipes[who]);
                peers[who].channel_transaction_completion(&mut penv, &u)?;
            }

            let env = channel_handler_env(allocator, rng).expect("should work");
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
                    solution: Program::from_nodeptr(env.allocator, solution)?.into(),
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

pub fn run_calpoker_test_with_action_list(
    allocator: &mut AllocEncoder,
    rng: &mut ChaCha8Rng,
    moves: &[GameAction],
    v1: bool,
) {
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

    let ph1 = new_peer(allocator, rng, false);
    let ph2 = new_peer(allocator, rng, true);
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
            &identities[0].puzzle_hash,
            &identities[0],
            &coins0[0],
            Amount::new(100),
        )
        .expect("should work");
    let (parent_coin_1, _rest_1) = simulator
        .transfer_coin_amount(
            allocator,
            &identities[1].puzzle_hash,
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
            rng,
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
        let mut env = channel_handler_env(allocator, rng).expect("should work");
        let mut penv = SimulatedPeerSystem::new(&mut env, &mut peers[1]);
        handlers[1]
            .start(&mut penv, parent_coin_1.clone())
            .expect("should work");
    }

    handshake(
        rng,
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

    quiesce(rng, allocator, Amount::new(200), &mut handlers, &mut peers).expect("should work");

    // Start game
    let game_ids = {
        let mut env = channel_handler_env(allocator, rng).expect("should work");
        do_first_game_start(&mut env, &mut peers[1], &mut handlers[1], v1)
    };

    {
        let mut env = channel_handler_env(allocator, rng).expect("should work");
        do_second_game_start(&mut env, &mut peers[0], &mut handlers[0], v1);
    }

    quiesce(rng, allocator, Amount::new(200), &mut handlers, &mut peers).expect("should work");

    assert!(peers[0].message_pipe.queue.is_empty());
    assert!(peers[1].message_pipe.queue.is_empty());

    // Game move execution starts here
    run_move_list(
        allocator,
        moves,
        &mut handlers,
        &mut peers,
        game_ids[0].clone(),
        rng,
    );
}

fn run_move_list(
    allocator: &mut AllocEncoder,
    moves: &[GameAction],
    handlers: &mut [PotatoHandler; 2],
    peers: &mut [SimulatedPeer; 2],
    game_id: GameID,
    rng: &mut ChaCha8Rng,
) {
    for this_move in moves.iter() {
        let (who, what) = if let GameAction::Move(who, what, _) = this_move {
            (who, what)
        } else {
            panic!();
        };

        {
            let entropy = rng.gen();
            let mut env = channel_handler_env(allocator, rng).expect("should work");
            let move_readable = what.clone();
            let mut penv = SimulatedPeerSystem::new(&mut env, &mut peers[who ^ 1]);
            handlers[who ^ 1]
                .make_move(&mut penv, &game_id, &move_readable, entropy)
                .expect("should work");
        }

        quiesce(rng, allocator, Amount::new(200), handlers, peers).expect("should work");
    }
}

#[derive(Debug)]
pub struct OpponentMessageInfo {
    pub opponent_move_size: usize,
    pub opponent_message: ReadableMove,
}

#[derive(Default, Debug)]
pub struct LocalTestUIReceiver {
    pub shutdown_complete: bool,
    pub game_started: Option<GameStartRecord>,
    pub game_finished: Option<Amount>,
    pub opponent_moved: bool,
    pub go_on_chain: bool,
    pub got_error: bool,
    pub opponent_moves: Vec<(GameID, usize, ReadableMove, Amount)>,
    pub opponent_messages: Vec<OpponentMessageInfo>,
}

impl ToLocalUI for LocalTestUIReceiver {
    fn opponent_moved(
        &mut self,
        _allocator: &mut AllocEncoder,
        id: &GameID,
        state_number: usize,
        readable: ReadableMove,
        my_share: Amount,
    ) -> Result<(), Error> {
        self.opponent_moved = true;
        self.opponent_moves
            .push((id.clone(), state_number, readable, my_share));
        Ok(())
    }

    fn game_message(
        &mut self,
        _allocator: &mut AllocEncoder,
        _id: &GameID,
        readable: ReadableMove,
    ) -> Result<(), Error> {
        self.opponent_messages.push(OpponentMessageInfo {
            opponent_move_size: self.opponent_moves.len(),
            opponent_message: readable.clone(),
        });
        Ok(())
    }

    fn game_start(&mut self, ids: &[GameID], failed: Option<GameStartFailed>) -> Result<(), Error> {
        self.game_started = Some(GameStartRecord {
            game_ids: ids.to_vec(),
            failed: failed.clone(),
        });
        Ok(())
    }

    fn game_finished(&mut self, _id: &GameID, my_share: Amount) -> Result<(), Error> {
        self.game_finished = Some(my_share);
        Ok(())
    }

    fn game_cancelled(&mut self, _id: &GameID) -> Result<(), Error> {
        self.game_finished = Some(Amount::default());
        Ok(())
    }

    fn shutdown_complete(&mut self, _reward_coin_string: Option<&CoinString>) -> Result<(), Error> {
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

pub struct GameRunOutcome {
    pub identities: [ChiaIdentity; 2],
    #[allow(dead_code)]
    pub cradles: [SynchronousGameCradle; 2],
    pub local_uis: [LocalTestUIReceiver; 2],
    pub simulator: Simulator,
}

fn reports_blocked(i: usize, blocked: &Option<(usize, usize)>) -> bool {
    if let Some((_, players)) = blocked {
        return players & (1 << i) != 0;
    }

    false
}

fn run_game_container_with_action_list_with_success_predicate(
    allocator: &mut AllocEncoder,
    rng: &mut ChaCha8Rng,
    private_keys: [ChannelHandlerPrivateKeys; 2],
    identities: &[ChiaIdentity],
    game_type: &[u8],
    extras: &Program,
    moves_input: &[GameAction],
    pred: GameRunEarlySuccessPredicate,
) -> Result<GameRunOutcome, Error> {
    let mut move_number = 0;

    // Coinset adapter for each side.
    let game_type_map = poker_collection(allocator);

    let neutral_pk: PrivateKey = rng.gen();
    let neutral_identity = ChiaIdentity::new(allocator, neutral_pk)?;

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
        &identities[0].puzzle_hash,
        &identities[0],
        &coins0[0],
        Amount::new(100),
    )?;
    let (parent_coin_1, _rest_1) = simulator.transfer_coin_amount(
        allocator,
        &identities[1].puzzle_hash,
        &identities[1],
        &coins1[0],
        Amount::new(100),
    )?;

    simulator.farm_block(&neutral_identity.puzzle_hash);

    let cradle1 = SynchronousGameCradle::new_with_keys(
        SynchronousGameCradleConfig {
            game_types: game_type_map.clone(),
            have_potato: true,
            identity: &identities[0],
            my_contribution: Amount::new(100),
            their_contribution: Amount::new(100),
            channel_timeout: Timeout::new(100),
            unroll_timeout: Timeout::new(5),
            reward_puzzle_hash: identities[0].puzzle_hash.clone(),
        },
        private_keys[0].clone(),
    );
    let cradle2 = SynchronousGameCradle::new_with_keys(
        SynchronousGameCradleConfig {
            game_types: game_type_map.clone(),
            have_potato: false,
            identity: &identities[1],
            my_contribution: Amount::new(100),
            their_contribution: Amount::new(100),
            channel_timeout: Timeout::new(100),
            unroll_timeout: Timeout::new(5),
            reward_puzzle_hash: identities[1].puzzle_hash.clone(),
        },
        private_keys[1].clone(),
    );
    let mut cradles = [cradle1, cradle2];
    let mut game_ids = Vec::default();
    let mut handshake_done = false;
    let mut can_move = false;
    let mut ending = None;

    let mut wait_blocks = None;
    let mut report_backlogs = [Vec::default(), Vec::default()];
    let mut start_step = 0;
    let mut num_steps = 0;

    // Give coins to the cradles.
    cradles[0].opening_coin(allocator, rng, parent_coin_0)?;
    cradles[1].opening_coin(allocator, rng, parent_coin_1)?;

    let global_move = |moves: &[GameAction], move_number: usize| {
        move_number < moves.len()
            && matches!(
                &moves[move_number],
                GameAction::Shutdown(_, _) | GameAction::WaitBlocks(_, _)
            )
    };

    while !matches!(ending, Some(0)) {
        num_steps += 1;
        debug!(
            "{num_steps} can move {can_move} {move_number} {:?}",
            &moves_input[move_number..]
        );
        debug!("local_uis[0].finished {:?}", local_uis[0].game_finished);
        debug!("local_uis[1].finished {:?}", local_uis[0].game_finished);

        assert!(num_steps < 200);

        if matches!(wait_blocks, Some((0, _))) {
            wait_blocks = None;
        }

        simulator.farm_block(&neutral_identity.puzzle_hash);
        let current_height = simulator.get_current_height();
        let current_coins = simulator.get_all_coins().expect("should work");
        let watch_report = coinset_adapter
            .make_report_from_coin_set_update(current_height as u64, &current_coins)?;

        if let Some(p) = &pred {
            if p(&cradles) {
                // Success.
                return Ok(GameRunOutcome {
                    identities: [identities[0].clone(), identities[1].clone()],
                    cradles,
                    local_uis,
                    simulator,
                });
            }
        }

        for i in 0..=1 {
            if local_uis[i].go_on_chain {
                // Perform on chain move.
                // Turn off the flag to go on chain.
                local_uis[i].go_on_chain = false;
                let got_error = local_uis[i].got_error;
                cradles[i].go_on_chain(allocator, rng, &mut local_uis[i], got_error)?;
            }

            if reports_blocked(i, &wait_blocks) {
                report_backlogs[i].push((current_height, watch_report.clone()));
            } else {
                cradles[i].new_block(allocator, rng, current_height, &watch_report)?;
            }

            while let Some(result) = cradles[i].idle(allocator, rng, &mut local_uis[i], 0)? {
                if matches!(result.resync, Some((_, true))) {
                    can_move = true;
                    debug!("resync requested at id {:?}", result.resync);
                    while move_number > 0
                        && (move_number >= moves_input.len()
                            || !matches!(moves_input[move_number], GameAction::Move(_, _, _)))
                    {
                        move_number -= 1;
                    }
                    debug!(
                        "{num_steps} can move {can_move} {move_number} {:?}",
                        &moves_input[move_number..]
                    );
                }

                for coin in result.coin_solution_requests.iter() {
                    let ps_res = simulator
                        .get_puzzle_and_solution(&coin.to_coin_id())
                        .expect("should work");
                    for cradle in cradles.iter_mut() {
                        cradle.report_puzzle_and_solution(
                            allocator,
                            rng,
                            coin,
                            ps_res.as_ref().map(|ps| (&ps.0, &ps.1)),
                        )?;
                    }
                }

                for tx in result.outbound_transactions.iter() {
                    debug!("PROCESS TX {tx:?}");
                    let included_result = simulator.push_tx(allocator, &tx.spends).into_gen()?;
                    debug!("included_result {included_result:?}");
                    // Don't assert on double spend since it is expected that some actions
                    // such as timeout could be launched by either or both on chain parties.
                    // Most of the time, the timeout is coalesced because the spends are equivalent
                    // and take place on the same block.  If we insert delays, we might see an
                    // attempt to spend the same coin and that's fine.
                    assert!(
                        included_result.code == 1
                            || (included_result.code == 3 && matches!(included_result.e, Some(5)))
                    );
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

        if !handshake_done && cradles.iter().all(|c| c.handshake_finished()) {
            if start_step == 0 {
                start_step += 1;
                continue;
            }

            // Start game.
            handshake_done = true;

            let game_id = cradles[0].next_game_id().unwrap();
            debug!("testing with game id {game_id:?}");
            game_ids = cradles[0].start_games(
                allocator,
                rng,
                true,
                &GameStart {
                    game_id: game_id.clone(),
                    amount: Amount::new(200),
                    my_contribution: Amount::new(100),
                    game_type: GameType(game_type.to_vec()),
                    timeout: Timeout::new(10),
                    my_turn: true,
                    parameters: extras.clone(),
                },
            )?;

            cradles[1].start_games(
                allocator,
                rng,
                false,
                &GameStart {
                    game_id,
                    amount: Amount::new(200),
                    my_contribution: Amount::new(100),
                    game_type: GameType(game_type.to_vec()),
                    timeout: Timeout::new(10),
                    my_turn: false,
                    parameters: extras.clone(),
                },
            )?;

            can_move = true;
        } else if let Some((wb, _)) = &mut wait_blocks {
            for i in 0..=1 {
                for (current_height, watch_report) in report_backlogs[i].iter() {
                    cradles[i].new_block(allocator, rng, *current_height, watch_report)?;
                }
                report_backlogs[i].clear();
            }
            if *wb > 0 {
                *wb -= 1;
            };
        } else if can_move
            || local_uis.iter().any(|l| l.opponent_moved)
            || global_move(moves_input, move_number)
        {
            can_move = false;
            assert!(!game_ids.is_empty());

            // Reset moved flags.
            for l in local_uis.iter_mut() {
                l.opponent_moved = false;
            }

            if move_number < moves_input.len() {
                let ga = &moves_input[move_number];
                move_number += 1;

                match ga {
                    GameAction::Move(who, readable, _share) => {
                        let is_my_move = cradles[*who].my_move_in_game(&game_ids[0]);
                        debug!("{who} make move: is my move? {is_my_move:?}");
                        if matches!(is_my_move, Some(true)) {
                            debug!("make move");
                            let readable_program = readable.to_program();
                            let encoded_readable_move = readable_program.bytes();
                            let entropy = rng.gen();
                            cradles[*who].make_move(
                                allocator,
                                rng,
                                &game_ids[0],
                                encoded_readable_move.to_vec(),
                                entropy,
                            )?;
                        } else {
                            debug!("put move back: not my turn");
                            move_number -= 1;
                            continue;
                        }
                    }
                    GameAction::GoOnChain(who) => {
                        debug!("go on chain");
                        local_uis[*who].go_on_chain = true;
                    }
                    GameAction::FakeMove(who, readable, move_data) => {
                        // This is a fake move.  We give that move to the given target channel
                        // handler as a their move.
                        debug!("make move");
                        let readable_program = readable.to_program();
                        let encoded_readable_move = readable_program.bytes();
                        let entropy = rng.gen();
                        // Do like we're sending a real message.
                        cradles[*who].make_move(
                            allocator,
                            rng,
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
                    GameAction::WaitBlocks(n, players) => {
                        wait_blocks = Some((*n, *players));
                    }
                    GameAction::Accept(who) | GameAction::Timeout(who) => {
                        debug!("{who} doing ACCEPT");
                        can_move = true;
                        cradles[*who].accept(allocator, rng, &game_ids[0])?;
                    }
                    GameAction::Shutdown(who, conditions) => {
                        can_move = true;
                        cradles[*who].shut_down(allocator, rng, conditions.clone())?;
                    }
                }
            }
        }
    }

    Ok(GameRunOutcome {
        identities: [identities[0].clone(), identities[1].clone()],
        cradles,
        local_uis,
        simulator,
    })
}

fn run_game_container_with_action_list(
    allocator: &mut AllocEncoder,
    rng: &mut ChaCha8Rng,
    private_keys: [ChannelHandlerPrivateKeys; 2],
    identities: &[ChiaIdentity],
    game_type: &[u8],
    extras: Rc<Program>,
    moves: &[GameAction],
) -> Result<GameRunOutcome, Error> {
    run_game_container_with_action_list_with_success_predicate(
        allocator,
        rng,
        private_keys,
        identities,
        game_type,
        &extras,
        moves,
        None,
    )
}

pub fn run_calpoker_container_with_action_list(
    allocator: &mut AllocEncoder,
    moves: &[GameAction],
    v1: bool,
) -> Result<GameRunOutcome, Error> {
    let seed_data: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed_data);
    let pk1: PrivateKey = rng.gen();
    let id1 = ChiaIdentity::new(allocator, pk1).expect("ok");
    let pk2: PrivateKey = rng.gen();
    let id2 = ChiaIdentity::new(allocator, pk2).expect("ok");
    let type_id = if v1 { b"ca1poker" } else { b"calpoker" };

    let private_keys: [ChannelHandlerPrivateKeys; 2] = rng.gen();
    let identities: [ChiaIdentity; 2] = [id1.clone(), id2.clone()];
    run_game_container_with_action_list_with_success_predicate(
        allocator,
        &mut rng,
        private_keys,
        &identities,
        type_id,
        &Program::from_hex("80")?,
        moves,
        None,
    )
}

fn get_balances_from_outcome(outcome: &GameRunOutcome) -> Result<(u64, u64), Error> {
    let p1_ph = outcome.identities[0].puzzle_hash.clone();
    let p2_ph = outcome.identities[1].puzzle_hash.clone();
    let p1_coins = outcome.simulator.get_my_coins(&p1_ph).into_gen()?;
    let p2_coins = outcome.simulator.get_my_coins(&p2_ph).into_gen()?;
    let p1_balance: u64 = p1_coins
        .iter()
        .map(|c| c.to_parts().map(|(_, _, amt)| amt.to_u64()).unwrap_or(0))
        .sum();
    let p2_balance: u64 = p2_coins
        .iter()
        .map(|c| c.to_parts().map(|(_, _, amt)| amt.to_u64()).unwrap_or(0))
        .sum();

    Ok((p1_balance, p2_balance))
}

fn check_calpoker_economic_result(
    allocator: &mut AllocEncoder,
    p0_view_of_cards: &(GameID, usize, ReadableMove, Amount),
    p1_view_of_cards: &(GameID, usize, ReadableMove, Amount),
    alice_outcome_move: &(GameID, usize, ReadableMove, Amount),
    bob_outcome_move: &(GameID, usize, ReadableMove, Amount),
    outcome: &GameRunOutcome,
) {
    let (p1_balance, p2_balance) = get_balances_from_outcome(outcome).expect("should work");

    for (pn, lui) in outcome.local_uis.iter().enumerate() {
        for (mn, the_move) in lui.opponent_moves.iter().enumerate() {
            let the_move_to_node = the_move.2.to_nodeptr(allocator).expect("should work");
            debug!(
                "player {pn} opponent move {mn} {the_move:?} {:?}",
                Node(the_move_to_node).to_hex(allocator)
            );
        }
    }

    let alice_cards = decode_readable_card_choices(allocator, p0_view_of_cards.2.clone())
        .expect("should get cards");
    let alice_outcome_node = alice_outcome_move
        .2
        .to_nodeptr(allocator)
        .expect("should work");
    let alice_outcome =
        decode_calpoker_readable(allocator, alice_outcome_node, Amount::new(200), false)
            .expect("should work");
    let bob_cards =
        decode_readable_card_choices(allocator, p1_view_of_cards.2.clone()).expect("should work");
    let bob_outcome_node = bob_outcome_move
        .2
        .to_nodeptr(allocator)
        .expect("should work");
    let bob_outcome = decode_calpoker_readable(allocator, bob_outcome_node, Amount::new(200), true)
        .expect("should work");

    assert_eq!(alice_cards, bob_cards);

    let (alice_used_cards, bob_used_cards) =
        get_final_used_cards(&alice_cards, &alice_outcome, &bob_outcome);

    debug!("alice_used_cards {alice_used_cards:?}");
    debug!("bob_used_cards   {bob_used_cards:?}");

    debug!("game outcome {bob_outcome:?}");
    debug!("p1 balance {p1_balance:?} p2 {p2_balance:?}");
    if bob_outcome.raw_win_direction == 1 {
        assert_eq!(p2_balance + 200, p1_balance);
    } else if bob_outcome.raw_win_direction == -1 {
        assert_eq!(p2_balance, p1_balance + 200);
    } else {
        assert_eq!(p2_balance, p1_balance);
    }
}

pub struct DebugGameSimSetup {
    pub private_keys: [ChannelHandlerPrivateKeys; 2],
    pub identities: [ChiaIdentity; 2],
    #[allow(dead_code)]
    pub debug_games: [BareDebugGameDriver; 2],
    #[allow(dead_code)]
    pub game_moves: Vec<DebugGameMoveInfo>,
    pub game_actions: Vec<GameAction>,
    pub args_program: Rc<Program>,
}

pub struct DebugGameTestMove {
    pub amt: u64,
    pub slash: u8,
}

impl DebugGameTestMove {
    pub fn new(amt: u64, slash: u8) -> DebugGameTestMove {
        DebugGameTestMove { amt, slash }
    }
}

pub fn add_debug_test_accept_shutdown(test_setup: &mut DebugGameSimSetup, wait: usize) {
    test_setup.game_actions.push(GameAction::Accept(0));
    test_setup
        .game_actions
        .push(GameAction::WaitBlocks(wait, 0));
    test_setup
        .game_actions
        .push(GameAction::WaitBlocks(wait, 1));
    test_setup
        .game_actions
        .push(GameAction::Shutdown(1, Rc::new(BasicShutdownConditions)));
}

pub fn add_debug_test_slash_shutdown(test_setup: &mut DebugGameSimSetup, wait: usize) {
    test_setup
        .game_actions
        .push(GameAction::WaitBlocks(wait, 0));
    test_setup
        .game_actions
        .push(GameAction::WaitBlocks(wait, 1));
    test_setup
        .game_actions
        .push(GameAction::Shutdown(0, Rc::new(BasicShutdownConditions)));
    test_setup
        .game_actions
        .push(GameAction::Shutdown(1, Rc::new(BasicShutdownConditions)));
}

pub fn setup_debug_test(
    allocator: &mut AllocEncoder,
    rng: &mut ChaCha8Rng,
    moves: &[DebugGameTestMove],
) -> Result<DebugGameSimSetup, Error> {
    let pk1: PrivateKey = rng.gen();
    let id1 = ChiaIdentity::new(allocator, pk1)?;
    let pk2: PrivateKey = rng.gen();
    let id2 = ChiaIdentity::new(allocator, pk2)?;

    let private_keys: [ChannelHandlerPrivateKeys; 2] = rng.gen();
    let identities: [ChiaIdentity; 2] = [id1.clone(), id2.clone()];

    let pid1 = ChiaIdentity::new(allocator, private_keys[0].my_referee_private_key.clone())?;
    let pid2 = ChiaIdentity::new(allocator, private_keys[1].my_referee_private_key.clone())?;
    let private_identities: [ChiaIdentity; 2] = [pid1, pid2];

    let mut debug_games = make_debug_games(allocator, rng, &private_identities)?;

    let mut game_actions = Vec::new();
    let mut game_moves = Vec::new();

    for (i, do_move) in moves.iter().enumerate() {
        let alice_turn = i % 2 == 0;

        let (alice, bob) = pair_of_array_mut(&mut debug_games);

        // Get some moves.
        let the_move = if alice_turn {
            alice.do_move(allocator, bob, Amount::new(do_move.amt), do_move.slash)?
        } else {
            bob.do_move(allocator, alice, Amount::new(do_move.amt), do_move.slash)?
        };

        if do_move.slash == 0 {
            assert!(the_move.slash.is_none());
        } else {
            assert_eq!(
                the_move.slash,
                Some(Rc::new(Program::from_bytes(&[do_move.slash])))
            );
        }

        game_actions.push(GameAction::Move(i % 2, the_move.ui_move.clone(), true));
        game_moves.push(the_move);
    }

    let args_curry = DebugGameCurry::new(
        allocator,
        &debug_games[0].alice_identity.puzzle_hash,
        &debug_games[0].bob_identity.puzzle_hash,
    );
    debug!("debug game curried data {args_curry:?}");
    let args = args_curry.expect("good").to_clvm(allocator).into_gen()?;
    let args_program = Rc::new(Program::from_nodeptr(allocator, args).expect("ok"));

    debug!("alice mover puzzle hash is {:?}", identities[0].puzzle_hash);
    debug!("bob   mover puzzle hash is {:?}", identities[0].puzzle_hash);

    Ok(DebugGameSimSetup {
        private_keys,
        identities,
        debug_games,
        game_moves,
        game_actions,
        args_program,
    })
}

pub fn test_funs() -> Vec<(&'static str, &'static dyn Fn())> {
    let mut res: Vec<(&'static str, &'static dyn Fn())> = Vec::new();
    res.push(("test_peer_in_sim", &|| {
        let mut allocator = AllocEncoder::new();
        let mut rng = ChaCha8Rng::from_seed([0; 32]);

        // Play moves
        let moves = prefix_test_moves(&mut allocator, false);
        run_calpoker_test_with_action_list(&mut allocator, &mut rng, &moves, false);
    }));
    res.push((
        "sim_test_with_peer_container_piss_off_peer_basic_on_chain",
        &|| {
            let mut allocator = AllocEncoder::new();
            let seed_data: [u8; 32] = [0; 32];
            let mut rng = ChaCha8Rng::from_seed(seed_data);
            let pk1: PrivateKey = rng.gen();
            let id1 = ChiaIdentity::new(&mut allocator, pk1).expect("ok");
            let pk2: PrivateKey = rng.gen();
            let id2 = ChiaIdentity::new(&mut allocator, pk2).expect("ok");

            let private_keys: [ChannelHandlerPrivateKeys; 2] = rng.gen();
            let identities: [ChiaIdentity; 2] = [id1.clone(), id2.clone()];

            let mut moves = prefix_test_moves(&mut allocator, false).to_vec();
            if let GameAction::Move(player, readable, _) = moves[3].clone() {
                moves.insert(3, GameAction::FakeMove(player, readable, vec![0; 500]));
            } else {
                panic!("no move 1 to replace");
            }
            run_game_container_with_action_list_with_success_predicate(
                &mut allocator,
                &mut rng,
                private_keys,
                &identities,
                b"calpoker",
                &Program::from_hex("80").unwrap(),
                &moves,
                Some(&|cradles| cradles[0].is_on_chain() && cradles[1].is_on_chain()),
            )
            .expect("should finish");
        },
    ));

    res.push(("sim_test_with_peer_container_off_chain_complete", &|| {
        let mut allocator = AllocEncoder::new();

        let mut moves = prefix_test_moves(&mut allocator, false).to_vec();
        moves.push(GameAction::Accept(0));
        moves.push(GameAction::Shutdown(1, Rc::new(BasicShutdownConditions)));
        let outcome = run_calpoker_container_with_action_list(&mut allocator, &moves, false)
            .expect("should finish");

        let p0_view_of_cards = &outcome.local_uis[0].opponent_moves[0];
        let p1_view_of_cards = &outcome.local_uis[1].opponent_moves[1];
        let alice_outcome_move = &outcome.local_uis[0].opponent_moves[1];
        let bob_outcome_move = &outcome.local_uis[1].opponent_moves[2];

        check_calpoker_economic_result(
            &mut allocator,
            p0_view_of_cards,
            p1_view_of_cards,
            alice_outcome_move,
            bob_outcome_move,
            &outcome,
        );
    }));

    res.push((
        "sim_test_with_peer_container_piss_off_peer_complete",
        &|| {
            let mut allocator = AllocEncoder::new();

            let mut moves = prefix_test_moves(&mut allocator, false).to_vec();
            moves.push(GameAction::Accept(0));
            moves.push(GameAction::Accept(1));
            moves.push(GameAction::Shutdown(0, Rc::new(BasicShutdownConditions)));
            moves.push(GameAction::Shutdown(1, Rc::new(BasicShutdownConditions)));
            if let GameAction::Move(player, readable, _) = moves[3].clone() {
                moves.insert(3, GameAction::FakeMove(player, readable, vec![0; 500]));
            } else {
                panic!("no move 1 to replace");
            }
            let outcome = run_calpoker_container_with_action_list(&mut allocator, &moves, false)
                .expect("should finish");

            debug!("outcome 0 {:?}", outcome.local_uis[0].opponent_moves);
            debug!("outcome 1 {:?}", outcome.local_uis[1].opponent_moves);

            let p0_view_of_cards = &outcome.local_uis[0].opponent_moves[0];
            let p1_view_of_cards = &outcome.local_uis[1].opponent_moves[1];
            let alice_outcome_move = &outcome.local_uis[0].opponent_moves[2];
            let bob_outcome_move = &outcome.local_uis[1].opponent_moves[3];

            check_calpoker_economic_result(
                &mut allocator,
                p0_view_of_cards,
                p1_view_of_cards,
                alice_outcome_move,
                bob_outcome_move,
                &outcome,
            );
        },
    ));

    res.push((
        "sim_test_with_peer_container_piss_off_peer_after_start_complete",
        &|| {
            let mut allocator = AllocEncoder::new();

            let moves = vec![
                GameAction::GoOnChain(1),
                GameAction::WaitBlocks(20, 1),
                GameAction::Shutdown(0, Rc::new(BasicShutdownConditions)),
                GameAction::Shutdown(1, Rc::new(BasicShutdownConditions)),
            ];

            let outcome = run_calpoker_container_with_action_list(&mut allocator, &moves, false)
                .expect("should finish");

            let (p1_balance, p2_balance) =
                get_balances_from_outcome(&outcome).expect("should work");
            assert_eq!(p2_balance, p1_balance + 200);
        },
    ));

    res.push((
        "sim_test_with_peer_container_piss_off_peer_after_accept_complete",
        &|| {
            let mut allocator = AllocEncoder::new();

            let mut moves = prefix_test_moves(&mut allocator, false).to_vec();
            moves.push(GameAction::Accept(0));
            moves.push(GameAction::GoOnChain(1));
            moves.push(GameAction::WaitBlocks(20, 1));
            moves.push(GameAction::Shutdown(0, Rc::new(BasicShutdownConditions)));
            moves.push(GameAction::Shutdown(1, Rc::new(BasicShutdownConditions)));
            let outcome = run_calpoker_container_with_action_list(&mut allocator, &moves, false)
                .expect("should finish");

            let p0_view_of_cards = &outcome.local_uis[0].opponent_moves[0];
            let p1_view_of_cards = &outcome.local_uis[1].opponent_moves[1];
            let alice_outcome_move = &outcome.local_uis[0].opponent_moves[1];
            let bob_outcome_move = &outcome.local_uis[1].opponent_moves[2];

            check_calpoker_economic_result(
                &mut allocator,
                p0_view_of_cards,
                p1_view_of_cards,
                alice_outcome_move,
                bob_outcome_move,
                &outcome,
            );
        },
    ));

    res.push((
        "sim_test_with_peer_container_piss_off_peer_timeout",
        &|| {
            let mut allocator = AllocEncoder::new();

            let mut moves = prefix_test_moves(&mut allocator, false).to_vec();
            let moves_len = moves.len();
            moves.remove(moves_len - 2);
            moves.remove(moves_len - 2);
            moves.push(GameAction::GoOnChain(0));
            moves.push(GameAction::WaitBlocks(120, 1));
            moves.push(GameAction::Shutdown(0, Rc::new(BasicShutdownConditions)));
            moves.push(GameAction::Shutdown(1, Rc::new(BasicShutdownConditions)));

            let outcome = run_calpoker_container_with_action_list(&mut allocator, &moves, false)
                .expect("should finish");

            let (p1_balance, p2_balance) =
                get_balances_from_outcome(&outcome).expect("should work");
            assert_eq!(p1_balance, p2_balance + 200);
        },
    ));

    res.push(("sim_test_with_peer_container_piss_off_peer_slash", &|| {
        let mut allocator = AllocEncoder::new();

        let mut moves = prefix_test_moves(&mut allocator, false).to_vec();
        // p2 chooses 5 cards.
        let move_3_node = [1, 0, 1, 0, 1, 0, 1, 1]
            .to_clvm(&mut allocator)
            .expect("should work");
        let changed_move = GameAction::Move(
            1,
            ReadableMove::from_program(Rc::new(
                Program::from_nodeptr(&mut allocator, move_3_node).expect("good"),
            )),
            true,
        );
        moves.truncate(3);
        moves.push(changed_move.clone());
        moves.push(changed_move);
        moves.push(GameAction::WaitBlocks(20, 1));
        moves.push(GameAction::Shutdown(0, Rc::new(BasicShutdownConditions)));
        moves.push(GameAction::Shutdown(1, Rc::new(BasicShutdownConditions)));

        let outcome = run_calpoker_container_with_action_list(&mut allocator, &moves, false)
            .expect("should finish");

        let (p1_balance, p2_balance) = get_balances_from_outcome(&outcome).expect("should work");
        // p1 (index 0) won the money because p2 (index 1) cheated by choosing 5 cards.
        assert_eq!(p1_balance, p2_balance + 200);
    }));

    res.push(("test_referee_play_debug_game_alice_slash", &|| {
        let mut allocator = AllocEncoder::new();
        let seed_data: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed_data);
        let moves = [
            DebugGameTestMove::new(0, 0),
            DebugGameTestMove::new(0, 0),
            DebugGameTestMove::new(50, 0),
            DebugGameTestMove::new(150, 3),
        ];

        let mut sim_setup = setup_debug_test(&mut allocator, &mut rng, &moves).expect("ok");
        add_debug_test_slash_shutdown(&mut sim_setup, 5);
        let outcome = run_game_container_with_action_list(
            &mut allocator,
            &mut rng,
            sim_setup.private_keys.clone(),
            &sim_setup.identities,
            b"debug",
            sim_setup.args_program.clone(),
            &sim_setup.game_actions,
        )
        .expect("should finish");

        let (p1_balance, p2_balance) = get_balances_from_outcome(&outcome).expect("should work");
        // Bob was slashable so alice gets the money.
        assert_eq!(p1_balance, p2_balance + 200);
    }));

    res.push(("test_referee_play_debug_game_bob_slash", &|| {
        let mut allocator = AllocEncoder::new();
        let seed_data: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed_data);
        let moves = [
            DebugGameTestMove::new(0, 0),
            DebugGameTestMove::new(0, 0),
            DebugGameTestMove::new(50, 0),
            DebugGameTestMove::new(150, 0),
            DebugGameTestMove::new(49, 7),
        ];

        let mut sim_setup = setup_debug_test(&mut allocator, &mut rng, &moves).expect("ok");
        add_debug_test_slash_shutdown(&mut sim_setup, 5);
        let outcome = run_game_container_with_action_list(
            &mut allocator,
            &mut rng,
            sim_setup.private_keys.clone(),
            &sim_setup.identities,
            b"debug",
            sim_setup.args_program.clone(),
            &sim_setup.game_actions,
        )
        .expect("should finish");

        let (p1_balance, p2_balance) = get_balances_from_outcome(&outcome).expect("should work");
        // Alice was slashable so bob gets the money.
        assert_eq!(p1_balance + 200, p2_balance);
    }));

    res.push(("test_debug_game_normal_with_mover_share_alice", &|| {
        let mut allocator = AllocEncoder::new();
        let seed_data: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed_data);
        let moves = [
            DebugGameTestMove::new(0, 0),
            DebugGameTestMove::new(0, 0),
            DebugGameTestMove::new(50, 0),
            DebugGameTestMove::new(150, 0),
            DebugGameTestMove::new(49, 0),
        ];

        let mut sim_setup = setup_debug_test(&mut allocator, &mut rng, &moves).expect("ok");
        add_debug_test_accept_shutdown(&mut sim_setup, 20);
        let outcome = run_game_container_with_action_list(
            &mut allocator,
            &mut rng,
            sim_setup.private_keys.clone(),
            &sim_setup.identities,
            b"debug",
            sim_setup.args_program.clone(),
            &sim_setup.game_actions,
        )
        .expect("should finish");

        let (p1_balance, p2_balance) = get_balances_from_outcome(&outcome).expect("should work");
        // Alice assigned bob 49, so alice is greater.
        let amount_diff = 151 - 49;
        debug!("p1_balance {p1_balance} p2_balance {p2_balance}");
        assert_eq!(p1_balance, p2_balance + amount_diff);
    }));

    res.push(("test_debug_game_normal_with_mover_share_bob", &|| {
        let mut allocator = AllocEncoder::new();
        let seed_data: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed_data);
        let moves = [
            DebugGameTestMove::new(0, 0),
            DebugGameTestMove::new(0, 0),
            DebugGameTestMove::new(50, 0),
            DebugGameTestMove::new(150, 0),
            DebugGameTestMove::new(49, 0),
            DebugGameTestMove::new(49, 0),
        ];

        let mut sim_setup = setup_debug_test(&mut allocator, &mut rng, &moves).expect("ok");
        add_debug_test_accept_shutdown(&mut sim_setup, 20);
        let outcome = run_game_container_with_action_list(
            &mut allocator,
            &mut rng,
            sim_setup.private_keys.clone(),
            &sim_setup.identities,
            b"debug",
            sim_setup.args_program.clone(),
            &sim_setup.game_actions,
        )
        .expect("should finish");

        let (p1_balance, p2_balance) = get_balances_from_outcome(&outcome).expect("should work");
        // Alice assigned bob 49, so alice is greater.
        let amount_diff = 151 - 49;
        debug!("p1_balance {p1_balance} p2_balance {p2_balance}");
        assert_eq!(p1_balance + amount_diff, p2_balance);
    }));

    res.push(("test_debug_game_out_of_money", &|| {
        let mut allocator = AllocEncoder::new();
        let seed_data: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed_data);
        let moves = [DebugGameTestMove::new(150, 0)];

        let mut sim_setup = setup_debug_test(&mut allocator, &mut rng, &moves).expect("ok");
        add_debug_test_accept_shutdown(&mut sim_setup, 20);
        let game_type: &[u8] = b"debug";
        let mut game_starts: [Option<GameStartFailed>; 2] = [None, None];

        let mut outcome = run_game_container_with_action_list_with_success_predicate(
            &mut allocator,
            &mut rng,
            sim_setup.private_keys.clone(),
            &sim_setup.identities,
            game_type,
            &sim_setup.args_program,
            &sim_setup.game_actions,
            Some(&|cradles| cradles[0].handshake_finished() && cradles[1].handshake_finished()),
        )
        .expect("should finish");

        let game_id = outcome.cradles[0].next_game_id().unwrap();
        let borrowed: &Program = sim_setup.args_program.borrow();
        let result1 = outcome.cradles[0].start_games(
            &mut allocator,
            &mut rng,
            true,
            &GameStart {
                game_id: game_id.clone(),
                amount: Amount::new(2000),
                my_contribution: Amount::new(1000),
                game_type: GameType(game_type.to_vec()),
                timeout: Timeout::new(10),
                my_turn: true,
                parameters: borrowed.clone(),
            },
        );

        assert!(result1.is_ok());

        let result2 = outcome.cradles[1].start_games(
            &mut allocator,
            &mut rng,
            true,
            &GameStart {
                game_id: game_id.clone(),
                amount: Amount::new(2000),
                my_contribution: Amount::new(1000),
                game_type: GameType(game_type.to_vec()),
                timeout: Timeout::new(10),
                my_turn: true,
                parameters: borrowed.clone(),
            },
        );

        for i in 0..100 {
            for (c, game_start) in game_starts.iter_mut().enumerate() {
                while let Some(result) = outcome.cradles[c]
                    .idle(&mut allocator, &mut rng, &mut outcome.local_uis[c], 0)
                    .unwrap()
                {
                    if let Some(gs) = &result.game_started {
                        *game_start = gs.failed.clone();
                    }

                    for msg in result.outbound_messages.iter() {
                        outcome.cradles[i ^ 1].deliver_message(msg).unwrap();
                    }

                    if !result.continue_on {
                        break;
                    }
                }
            }
        }

        assert!(result2.is_ok());
        assert!(matches!(game_starts[0], Some(GameStartFailed::OutOfMoney)));
        assert!(game_starts[1].is_none());
    }));

    res.push(("test_calpoker_v1_smoke", &|| {
        let mut allocator = AllocEncoder::new();

        // Play moves
        let mut moves = prefix_test_moves(&mut allocator, true).to_vec();
        moves.push(GameAction::Accept(0));
        moves.push(GameAction::Shutdown(1, Rc::new(BasicShutdownConditions)));

        let outcome = run_calpoker_container_with_action_list(&mut allocator, &moves, true)
            .expect("should finish");

        let (p1_balance, p2_balance) = get_balances_from_outcome(&outcome).expect("should work");
        assert_eq!(p2_balance, p1_balance + 200);
    }));

    res
}
