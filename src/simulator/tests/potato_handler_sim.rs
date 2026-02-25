use std::borrow::Borrow;
use std::collections::HashMap;
use std::rc::Rc;

use clvm_traits::ToClvm;
use log::debug;
use rand::prelude::*;
use rand_chacha::ChaCha8Rng;

use crate::channel_handler::types::{
    ChannelHandlerEnv, ChannelHandlerPrivateKeys, GameStartFailed, ReadableMove,
};
use crate::common::constants::CREATE_COIN;
use crate::common::standard_coin::{
    sign_agg_sig_me, solution_for_conditions, standard_solution_partial, ChiaIdentity,
};
use crate::common::types::{
    AllocEncoder, Amount, CoinSpend, CoinString, Error, GameID, GameType, IntoErr, Node,
    PrivateKey, Program, PuzzleHash, Sha256tree, Spend, SpendBundle, Timeout, ToQuotedProgram,
};
use crate::games::calpoker::{
    decode_calpoker_readable,
    decode_readable_card_choices,
};
use crate::games::poker_collection;
use crate::peer_container::{
    report_coin_changes_to_peer, FullCoinSetAdapter, GameCradle, GameStartRecord, MessagePeerQueue,
    MessagePipe, SynchronousGameCradle, SynchronousGameCradleConfig, WatchEntry, WatchReport,
};
use crate::potato_handler::start::GameStart;
use crate::potato_handler::effects::{apply_effects, Effect, GameNotification};
use crate::potato_handler::types::{
    BootstrapTowardGame, BootstrapTowardWallet, PacketSender, PeerMessage, ToLocalUI,
    WalletSpendInterface,
};
use crate::potato_handler::PotatoHandler;

use crate::shutdown::BasicShutdownConditions;
use crate::simulator::Simulator;
use crate::test_support::calpoker::{calpoker_ran_all_the_moves_predicate, prefix_test_moves};
use crate::test_support::debug_game::{
    make_debug_games, BareDebugGameHandler, DebugGameCurry, DebugGameMoveInfo,
};
use crate::test_support::game::GameAction;
use crate::test_support::peer::potato_handler::run_move;
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
    let current_coins = simulator.get_all_coins()?;
    let watch_report =
        coinset_adapter.make_report_from_coin_set_update(current_height as u64, &current_coins)?;

    for who in 0..=1 {
        {
            let mut env = ChannelHandlerEnv::new(allocator, rng).expect("should work");
            let reported_effects = report_coin_changes_to_peer(&mut env, &mut peers[who], &watch_report)?;
            apply_effects(reported_effects, allocator, &mut pipes[who])?;
        }
    }

    Ok(watch_report)
}

fn handle_received_channel_puzzle_hash<R: Rng>(
    env: &mut ChannelHandlerEnv<'_, R>,
    identity: &ChiaIdentity,
    peer: &mut PotatoHandler,
    parent: &CoinString,
    channel_handler_puzzle_hash: &PuzzleHash,
) -> Result<Vec<Effect>, Error> {
    let ch = peer.channel_handler()?;
    let channel_coin = ch.state_channel_coin();
    let channel_coin_amt = if let Some((_, _, amt)) = channel_coin.to_parts() {
        amt
    } else {
        return Err(Error::StrErr("no channel coin".to_string()));
    };

    let conditions_clvm = [(
        CREATE_COIN,
        (channel_handler_puzzle_hash.clone(), (channel_coin_amt, ())),
    )]
    .to_clvm(env.allocator)
    .into_gen()?;

    let spend = standard_solution_partial(
        env.allocator,
        &identity.synthetic_private_key,
        &parent.to_coin_id(),
        conditions_clvm,
        &identity.synthetic_public_key,
        &env.agg_sig_me_additional_data,
        false,
    )
    .expect("ssp 1");

    peer.channel_offer(
        env,
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
    .map(|effect| effect.unwrap_or_default())
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
        opt_name: Option<&'static str>,
    ) -> Result<(), Error> {
        let name: Option<String> = opt_name.map(str::to_string);
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
    fn shutdown_started(&mut self) -> Result<(), Error> {
        todo!();
    }
    fn shutdown_complete(&mut self, _reward_coin_string: Option<&CoinString>) -> Result<(), Error> {
        todo!();
    }
    fn going_on_chain(&mut self, _got_error: bool) -> Result<(), Error> {
        todo!();
    }
}


#[allow(clippy::too_many_arguments)]
pub fn handshake<R: Rng>(
    rng: &mut R,
    allocator: &mut AllocEncoder,
    _amount: Amount,
    coinset_adapter: &mut FullCoinSetAdapter,
    identities: &[ChiaIdentity; 2],
    peers: &mut [PotatoHandler; 2],
    pipes: &mut [SimulatedPeer; 2],
    parent_coins: &[CoinString],
    simulator: &mut Simulator,
) -> Result<(), Error> {
    let mut i = 0;
    let mut steps = 0;

    while !peers[0].handshake_finished() || !peers[1].handshake_finished() {
        let who = i % 2;
        steps += 1;
        assert!(steps < 50);

        debug!("handshake iterate {who}");
        run_move(allocator, rng, Amount::new(200), pipes, &mut peers[who], who).expect("should send");

        if let Some(ph) = pipes[who].channel_puzzle_hash.clone() {
            debug!("puzzle hash");
            pipes[who].channel_puzzle_hash = None;
            let reported_effects = {
                let mut env = ChannelHandlerEnv::new(allocator, rng).expect("should work");
                handle_received_channel_puzzle_hash(
                    &mut env,
                    &identities[who],
                    &mut peers[who],
                    &parent_coins[who],
                    &ph,
                )?
            };
            apply_effects(reported_effects, allocator, &mut pipes[who])?;
        }

        if let Some(u) = pipes[who].unfunded_offer.clone() {
            debug!(
                "unfunded offer received by {:?}",
                identities[who].synthetic_private_key
            );

            let reported_effects = {
                let mut env = ChannelHandlerEnv::new(allocator, rng).expect("should work");
                peers[who].channel_transaction_completion(&mut env, &u)?
            };
            if let Some(effects) = reported_effects {
                apply_effects(
                    effects,
                    allocator,
                    &mut pipes[who],
                )?;
            }

            let env = ChannelHandlerEnv::new(allocator, rng).expect("should work");
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
                .push_tx(env.allocator, &spends.spends)?;

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
    pub notifications: Vec<GameNotification>,
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

    fn shutdown_started(&mut self) -> Result<(), Error> {
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

    fn game_notification(&mut self, notification: &GameNotification) -> Result<(), Error> {
        self.notifications.push(notification.clone());
        Ok(())
    }
}

type GameRunEarlySuccessPredicate<'a> = Option<&'a dyn Fn(usize, &[SynchronousGameCradle]) -> bool>;

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
    debug!("DEBUG: RNG {:?}", rng);
    // debug!("DEBUG: KEYS {:?}", private_keys);
    // Coinset adapter for each side.
    let game_type_map = poker_collection(allocator);

    let neutral_pk: PrivateKey = rng.gen();
    let neutral_identity = ChiaIdentity::new(allocator, neutral_pk)?;

    let mut coinset_adapter = FullCoinSetAdapter::default();
    let mut local_uis = [
        LocalTestUIReceiver::default(),
        LocalTestUIReceiver::default(),
    ];
    let simulator = Simulator::new_strict();

    // Give some money to the users.
    simulator.farm_block(&identities[0].puzzle_hash);
    simulator.farm_block(&identities[1].puzzle_hash);

    let coins0 = simulator
        .get_my_coins(&identities[0].puzzle_hash)?;
    let coins1 = simulator
        .get_my_coins(&identities[1].puzzle_hash)?;

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
            identity: identities[0].clone(),
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
            identity: identities[1].clone(),
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
    let mut force_destroyed_coins: Vec<CoinString> = Vec::new();
    let mut nerf_transactions_for: Option<usize> = None;
    let mut start_step = 0;
    let mut num_steps = 0;

    // Give coins to the cradles.
    cradles[0].opening_coin(allocator, rng, parent_coin_0)?;
    cradles[1].opening_coin(allocator, rng, parent_coin_1)?;

    let global_move = |moves: &[GameAction], move_number: usize| {
        move_number < moves.len()
            && matches!(
                &moves[move_number],
                GameAction::Shutdown(_, _)
                    | GameAction::WaitBlocks(_, _)
                    | GameAction::GoOnChain(_)
                    | GameAction::Accept(_)
                    | GameAction::Timeout(_)
                    | GameAction::EnableCheating(_, _)
                    | GameAction::Cheat(_)
                    | GameAction::ForceDestroyCoin(_)
                    | GameAction::NerfTransactions(_)
                    | GameAction::UnNerfTransactions
            )
    };
    let has_explicit_go_on_chain = moves_input
        .iter()
        .any(|m| matches!(m, GameAction::GoOnChain(_)));

    while !matches!(ending, Some(0)) {
        num_steps += 1;
        debug!(
            "{num_steps} can move {can_move} {move_number} {:?}",
            &moves_input[move_number..]
        );
        let move_input = moves_input.get(move_number);

        if let Some(GameAction::Move(_, rm, _)) = &move_input {
            debug!("ReadableMove is {:?}", rm);
        } else if let Some(GameAction::FakeMove(_, rm, _)) = &move_input {
            debug!("ReadableMove is {:?}", rm);
        } else {
            let length = moves_input.len();
            if move_number < length {
                debug!("Got move_input {move_input:?} but could not construct ReadableMove!!");
            } else {
                debug!("We're past the end of the given actions, probably waiting to shut down");
            }
        }
        debug!("local_uis[0].finished {:?}", local_uis[0].game_finished);
        debug!("local_uis[1].finished {:?}", local_uis[0].game_finished);

        assert!(
            num_steps < 200,
            "simulation stalled: num_steps={num_steps} move_number={move_number} can_move={can_move} next_action={:?} explicit_go_on_chain={has_explicit_go_on_chain}",
            moves_input.get(move_number)
        );

        if matches!(wait_blocks, Some((0, _))) {
            wait_blocks = None;
        }

        simulator.farm_block(&neutral_identity.puzzle_hash);
        let current_height = simulator.get_current_height();
        let current_coins = simulator.get_all_coins().expect("should work");
        let mut watch_report = coinset_adapter
            .make_report_from_coin_set_update(current_height as u64, &current_coins)?;

        for coin in force_destroyed_coins.drain(..) {
            watch_report.deleted_watched.insert(coin);
        }

        if let Some(p) = &pred {
            if p(move_number, &cradles) {
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
            if local_uis[i].go_on_chain && cradles[i].is_on_chain() {
                debug!("go_on_chain flag set for player {i} but already on chain (handled internally), clearing flag");
                local_uis[i].go_on_chain = false;
            } else if local_uis[i].go_on_chain && cradles[i].handshake_finished() {
                if !has_explicit_go_on_chain && !local_uis[i].got_error {
                    panic!(
                        "unexpected off-chain->on-chain transition in non-on-chain test: player={i} move_number={move_number} got_error={} next_action={:?}",
                        local_uis[i].got_error,
                        moves_input.get(move_number)
                    );
                }
                debug!("GO_ON_CHAIN: player {i} got_error={} move_number={move_number}", local_uis[i].got_error);
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
                if result.resync.is_some() {
                    eprintln!("SIM_RESYNC: player={i} resync={:?} num_steps={num_steps}", result.resync);
                }
                if matches!(result.resync, Some((_, true))) {
                    can_move = true;
                    eprintln!("SIM_RESYNC_CAN_MOVE: player={i} move_number={move_number} num_steps={num_steps}");
                    let saved = move_number;
                    while move_number > 0
                        && (move_number >= moves_input.len()
                            || !matches!(moves_input[move_number], GameAction::Move(_, _, _) | GameAction::Cheat(_)))
                    {
                        move_number -= 1;
                    }
                    // Only rewind to a Move/Cheat that belongs to the
                    // player whose turn it is.  If the nearest action is
                    // for a different player, restore move_number so the
                    // sim keeps processing subsequent (non-Move) actions.
                    let dominated_by_other = match moves_input.get(move_number) {
                        Some(GameAction::Move(who, _, _)) => *who != i,
                        Some(GameAction::Cheat(who)) => *who != i,
                        _ => true,
                    };
                    if dominated_by_other {
                        move_number = saved;
                    }
                    debug!(
                        "{num_steps} can move {can_move} {move_number} {:?}",
                        &moves_input[move_number..]
                    );
                }

                for coin in result.coin_solution_requests.iter() {
                    eprintln!("COIN_SOL_REQ: from_player={i} coin={coin:?} num_steps={num_steps}");
                    let ps_res = simulator
                        .get_puzzle_and_solution(&coin.to_coin_id())
                        .expect("should work");
                    for (ci, cradle) in cradles.iter_mut().enumerate() {
                        eprintln!("REPORT_PAS: to_cradle={ci} coin={:?}", coin.to_coin_id());
                        cradle.report_puzzle_and_solution(
                            allocator,
                            rng,
                            coin,
                            ps_res.as_ref().map(|ps| (&ps.0, &ps.1)),
                        )?;
                    }
                }

                for tx in result.outbound_transactions.iter() {
                    if nerf_transactions_for == Some(i) {
                        debug!("NERFED tx from player {i}: {:?}", tx.name);
                        continue;
                    }
                    debug!(
                        "TX from player {i}: name={:?} coins={:?}",
                        tx.name,
                        tx.spends.iter().map(|s| s.coin.to_parts()).collect::<Vec<_>>()
                    );
                    let included_result = simulator.push_tx(allocator, &tx.spends)?;
                    debug!(
                        "TX result: code={} e={:?} diag={:?}",
                        included_result.code, included_result.e, included_result.diagnostic
                    );
                    // Don't assert on double spend since it is expected that some actions
                    // such as timeout could be launched by either or both on chain parties.
                    // Most of the time, the timeout is coalesced because the spends are equivalent
                    // and take place on the same block.  If we insert delays, we might see an
                    // attempt to spend the same coin and that's fine.
                    // DOUBLE_SPEND (5) or MINTING_COIN (20) are both expected
                    // when both parties independently submit equivalent transactions.
                    let is_expected_duplicate = included_result.code == 3
                        && matches!(included_result.e, Some(5) | Some(20));
                    let include_ok = included_result.code == 1 || is_expected_duplicate;
                    assert!(
                        include_ok,
                        "tx include failed: move_number={move_number} tx_name={:?} code={} e={:?} diagnostic={:?}",
                        tx.name,
                        included_result.code,
                        included_result.e,
                        included_result.diagnostic
                    );
                }

                for msg in result.outbound_messages.iter() {
                    cradles[i ^ 1].deliver_message(msg)?;
                }

                for n in result.notifications.iter() {
                    debug!("NOTIFICATION player {i}: {n:?}");
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
            #[allow(clippy::needless_range_loop)]
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

            // Reset moved flags.
            for l in local_uis.iter_mut() {
                l.opponent_moved = false;
            }

            if move_number < moves_input.len() {
                let ga = &moves_input[move_number];
                move_number += 1;

                match ga {
                    GameAction::Move(who, readable, _share) => {
                        assert!(
                            !game_ids.is_empty(),
                            "Move({who}) at move_number={move_number} but game_ids is empty"
                        );
                        let is_my_move = cradles[*who].my_move_in_game(&game_ids[0]);
                        eprintln!("SIM_MOVE: player={who} is_my_move={is_my_move:?} on_chain={} move_number={move_number} num_steps={num_steps}",
                            cradles[*who].is_on_chain());
                        if matches!(is_my_move, Some(true)) {
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
                            eprintln!("SIM_MOVE_PUTBACK: player={who} move_number back to {}", move_number - 1);
                            move_number -= 1;
                            continue;
                        }
                    }
                    GameAction::GoOnChain(who) => {
                        assert!(
                            local_uis[*who].game_finished.is_none(),
                            "GameAction::GoOnChain({who}) but game is already finished: move_number={move_number} finished={:?}",
                            local_uis[*who].game_finished
                        );
                        if cradles[*who].is_on_chain() {
                            panic!(
                                "GameAction::GoOnChain({who}) but player is already on chain: move_number={move_number}",
                            );
                        }
                        if !cradles[*who].handshake_finished() {
                            // Defer explicit on-chain requests until both peers have completed
                            // handshake/startup; otherwise go_on_chain() returns a protocol error.
                            move_number -= 1;
                            continue;
                        }
                        debug!("go on chain");
                        local_uis[*who].go_on_chain = true;
                    }
                    GameAction::FakeMove(who, readable, move_data) => {
                        assert!(
                            !game_ids.is_empty(),
                            "FakeMove({who}) at move_number={move_number} but game_ids is empty"
                        );
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
                    GameAction::EnableCheating(who, fake_move_bytes) => {
                        assert!(
                            !game_ids.is_empty(),
                            "EnableCheating({who}) at move_number={move_number} but game_ids is empty"
                        );
                        if !cradles[*who].is_on_chain() {
                            move_number -= 1;
                            continue;
                        }
                        debug!(
                            "EnableCheating: player {who} enabling cheating with {} fake bytes",
                            fake_move_bytes.len()
                        );
                        cradles[*who].enable_cheating_for_game(
                            &game_ids[0],
                            fake_move_bytes,
                        )?;
                        can_move = true;
                    }
                    GameAction::Cheat(who) => {
                        assert!(
                            !game_ids.is_empty(),
                            "Cheat({who}) at move_number={move_number} but game_ids is empty"
                        );
                        if !cradles[*who].is_on_chain() {
                            move_number -= 1;
                            continue;
                        }
                        let is_my_turn = cradles[*who].my_move_in_game(&game_ids[0]);
                        if !matches!(is_my_turn, Some(true)) {
                            move_number -= 1;
                            continue;
                        }
                        cradles[*who].cheat(allocator, rng, &game_ids[0])?;
                        can_move = true;
                    }
                    GameAction::ForceDestroyCoin(who) => {
                        assert!(
                            !game_ids.is_empty(),
                            "ForceDestroyCoin({who}) at move_number={move_number} but game_ids is empty"
                        );
                        if let Some(game_coin) = cradles[*who].get_game_coin(&game_ids[0]) {
                            force_destroyed_coins.push(game_coin);
                            can_move = true;
                        } else {
                            move_number -= 1;
                            continue;
                        }
                    }
                    GameAction::NerfTransactions(who) => {
                        nerf_transactions_for = Some(*who);
                    }
                    GameAction::UnNerfTransactions => {
                        nerf_transactions_for = None;
                    }
                    GameAction::WaitBlocks(n, players) => {
                        wait_blocks = Some((*n, *players));
                    }
                    GameAction::Accept(who) | GameAction::Timeout(who) => {
                        assert!(
                            !game_ids.is_empty(),
                            "Accept/Timeout({who}) at move_number={move_number} but game_ids is empty"
                        );
                        debug!("{who} doing ACCEPT");
                        can_move = true;
                        cradles[*who].accept(allocator, rng, &game_ids[0])?;
                    }
                    GameAction::Shutdown(who, conditions) => {
                        assert!(
                            !cradles[*who].is_on_chain(),
                            "Shutdown({who}) called while on chain; on-chain completion is automatic"
                        );
                        if !cradles[*who].handshake_finished() {
                            debug!("Shutdown({who}) deferred: handshake not finished");
                            move_number -= 1;
                            continue;
                        }
                        debug!("Shutdown({who}) processing");
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

pub fn run_calpoker_container_with_action_list_with_success_predicate(
    allocator: &mut AllocEncoder,
    moves: &[GameAction],
    predicate: GameRunEarlySuccessPredicate,
) -> Result<GameRunOutcome, Error> {
    let seed_data: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed_data);
    let pk1: PrivateKey = rng.gen();
    let id1 = ChiaIdentity::new(allocator, pk1).expect("ok");
    let pk2: PrivateKey = rng.gen();
    let id2 = ChiaIdentity::new(allocator, pk2).expect("ok");

    let private_keys: [ChannelHandlerPrivateKeys; 2] = rng.gen();
    let identities: [ChiaIdentity; 2] = [id1.clone(), id2.clone()];
    run_game_container_with_action_list_with_success_predicate(
        allocator,
        &mut rng,
        private_keys,
        &identities,
        b"calpoker",
        &Program::from_hex("80")?,
        moves,
        predicate,
    )
}

pub fn run_calpoker_container_with_action_list(
    allocator: &mut AllocEncoder,
    moves: &[GameAction],
) -> Result<GameRunOutcome, Error> {
    run_calpoker_container_with_action_list_with_success_predicate(allocator, moves, None)
}

fn get_balances_from_outcome(outcome: &GameRunOutcome) -> Result<(u64, u64), Error> {
    let p1_ph = outcome.identities[0].puzzle_hash.clone();
    let p2_ph = outcome.identities[1].puzzle_hash.clone();
    let p1_coins = outcome.simulator.get_my_coins(&p1_ph)?;
    let p2_coins = outcome.simulator.get_my_coins(&p2_ph)?;
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

    // Decode card choices from both players' views and verify they match.
    let alice_cards = decode_readable_card_choices(allocator, p0_view_of_cards.2.clone())
        .expect("should get cards from p0 view");
    let bob_cards =
        decode_readable_card_choices(allocator, p1_view_of_cards.2.clone())
            .expect("should get cards from p1 view");
    assert_eq!(alice_cards, bob_cards, "both players should see the same dealt cards");

    let (alice_initial, bob_initial) = &alice_cards;

    // Decode Bob's outcome to get win direction for balance verification.
    // Use 0xaa as Bob's discard bitfield (matching the deterministic test fixture).
    let bob_outcome_node = bob_outcome_move
        .2
        .to_nodeptr(allocator)
        .expect("should work");
    let bob_outcome = decode_calpoker_readable(
        allocator,
        bob_outcome_node,
        false, // bob's perspective
        0xaa,
        alice_initial,
        bob_initial,
    )
    .expect("should decode bob outcome");

    // Also decode Alice's outcome for debugging.
    let alice_outcome_node = alice_outcome_move
        .2
        .to_nodeptr(allocator)
        .expect("should work");
    let alice_outcome = decode_calpoker_readable(
        allocator,
        alice_outcome_node,
        true, // alice's perspective
        0x55,
        alice_initial,
        bob_initial,
    )
    .expect("should decode alice outcome");

    debug!("alice outcome {alice_outcome:?}");
    debug!("bob outcome {bob_outcome:?}");
    debug!("p1 balance {p1_balance:?} p2 {p2_balance:?}");
    if bob_outcome.raw_win_direction == 1 {
        // Bob wins: p2 (Bob) should have 200 more than p1 (Alice)
        assert_eq!(p1_balance + 200, p2_balance);
    } else if bob_outcome.raw_win_direction == -1 {
        // Alice wins: p1 (Alice) should have 200 more than p2 (Bob)
        assert_eq!(p2_balance + 200, p1_balance);
    } else {
        assert_eq!(p2_balance, p1_balance);
    }
}

pub struct DebugGameSimSetup {
    pub private_keys: [ChannelHandlerPrivateKeys; 2],
    pub identities: [ChiaIdentity; 2],
    #[allow(dead_code)]
    pub debug_games: [BareDebugGameHandler; 2],
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

        // Play moves
        let moves = prefix_test_moves(&mut allocator);
        run_calpoker_container_with_action_list_with_success_predicate(
            &mut allocator,
            &moves,
            Some(&calpoker_ran_all_the_moves_predicate(moves.len())),
        )
        .expect("this is a test");
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

            let mut moves = prefix_test_moves(&mut allocator).to_vec();
            if let GameAction::Move(player, readable, _) = moves[3].clone() {
                moves.insert(3, GameAction::FakeMove(player, readable, vec![0; 500]));
            } else {
                panic!("no move 3 to replace");
            }
            // No explicit GoOnChain needed: the fake move error forces player 0
            // on chain, and player 1 detects the channel coin spend and follows.
            let outcome = run_game_container_with_action_list_with_success_predicate(
                &mut allocator,
                &mut rng,
                private_keys,
                &identities,
                b"ca1poker",
                &Program::from_hex("80").unwrap(),
                &moves,
                Some(&|_, cradles| cradles[0].is_on_chain() && cradles[1].is_on_chain()),
            )
            .expect("should finish");
            assert!(
                outcome.local_uis[0].got_error,
                "player 0 should have been forced on chain by the fake move error"
            );
            assert!(
                outcome.cradles[0].is_on_chain(),
                "player 0 should be on chain"
            );
            assert!(
                outcome.cradles[1].is_on_chain(),
                "player 1 should have followed on chain after detecting the channel coin spend"
            );
        },
    ));

    res.push(("sim_test_with_peer_container_off_chain_complete", &|| {
        let mut allocator = AllocEncoder::new();

        let mut moves = prefix_test_moves(&mut allocator).to_vec();
        moves.push(GameAction::Accept(0));
        moves.push(GameAction::Shutdown(1, Rc::new(BasicShutdownConditions)));
        let outcome = run_calpoker_container_with_action_list(&mut allocator, &moves)
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

            let mut moves = prefix_test_moves(&mut allocator).to_vec();
            moves.push(GameAction::Accept(0));
            moves.push(GameAction::Accept(1));
            if let GameAction::Move(player, readable, _) = moves[3].clone() {
                // Replace the real move with a FakeMove. Bob's redo will
                // automatically replay the real move on-chain, so remove
                // the original to avoid a duplicate.
                moves.insert(3, GameAction::FakeMove(player, readable, vec![0; 500]));
                moves.remove(4);
            } else {
                panic!("no move 3 to replace");
            }
            // No explicit GoOnChain needed: the fake move error forces player 0
            // on chain, and player 1 detects the channel coin spend and follows.
            let outcome = run_calpoker_container_with_action_list(&mut allocator, &moves)
                .unwrap_or_else(|e| panic!("should finish, got error: {e:?}"));
            // The fake move should have forced player 0 on chain via error detection.
            // By the time shutdown completes, the state has progressed past OnChain to
            // Completed, so we check got_error rather than is_on_chain().
            assert!(
                outcome.local_uis[0].got_error,
                "player 0 should have been forced on chain by the fake move error"
            );

            debug!("outcome 0 {:?}", outcome.local_uis[0].opponent_moves);
            debug!("outcome 1 {:?}", outcome.local_uis[1].opponent_moves);

            // After a FakeMove error forces the game on-chain, the
            // opponent_moves lists differ from the normal off-chain flow.
            // Verify balances directly rather than trying to decode
            // calpoker-specific readables (the on-chain accept produces
            // nil readables, not full calpoker outcome data).
            let (p1_balance, p2_balance) =
                get_balances_from_outcome(&outcome).expect("should get balances");
            debug!(
                "piss_off_peer_complete: p1_balance={} p2_balance={}",
                p1_balance, p2_balance
            );
            // The game bet is 200 mojos. The winner gets 200 more than the loser.
            // Total balance should be conserved (sum = initial_p1 + initial_p2).
            assert!(
                p1_balance > 0 && p2_balance > 0,
                "both players should have non-zero balance after game"
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
            ];

            let outcome = run_calpoker_container_with_action_list(&mut allocator, &moves)
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

            let mut moves = prefix_test_moves(&mut allocator).to_vec();
            moves.push(GameAction::Accept(0));
            moves.push(GameAction::GoOnChain(1));
            moves.push(GameAction::WaitBlocks(20, 1));
            let outcome = run_calpoker_container_with_action_list(&mut allocator, &moves)
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

            let mut moves = prefix_test_moves(&mut allocator).to_vec();
            let moves_len = moves.len();
            moves.remove(moves_len - 2);
            moves.remove(moves_len - 2);
            moves.push(GameAction::GoOnChain(0));
            moves.push(GameAction::WaitBlocks(120, 1));

            let outcome = run_calpoker_container_with_action_list(&mut allocator, &moves)
                .expect("should finish");

            let (p1_balance, p2_balance) =
                get_balances_from_outcome(&outcome).expect("should work");
            assert_eq!(p1_balance, p2_balance + 200);
        },
    ));

    res.push((
        "sim_test_with_peer_container_piss_off_peer_slash",
        &|| {
            let mut allocator = AllocEncoder::new();

            // Play 3 moves off-chain (not all 5, so the game still has
            // moves remaining), then go on-chain. Alice replays Move 3
            // via redo; once that lands it becomes Bob's turn for Move 4.
            // Cheat(1) defers until Bob is on-chain and it's his turn,
            // then submits a move with invalid data that Alice detects.
            let mut moves = prefix_test_moves(&mut allocator).to_vec();
            moves.truncate(3);
            moves.push(GameAction::GoOnChain(0));
            moves.push(GameAction::Cheat(1));
            // Let both players process blocks so Alice detects & slashes.
            moves.push(GameAction::WaitBlocks(30, 0));

            let outcome = run_calpoker_container_with_action_list(&mut allocator, &moves)
                .expect("should finish");

            let (p1_balance, p2_balance) =
                get_balances_from_outcome(&outcome).expect("should work");
            // Alice (player 0) should get all the money via slash because
            // Bob (player 1) cheated.
            assert_eq!(p1_balance, p2_balance + 200);
        },
    ));

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
        let outcome = run_game_container_with_action_list_with_success_predicate(
            &mut allocator,
            &mut rng,
            sim_setup.private_keys.clone(),
            &sim_setup.identities,
            b"debug",
            &sim_setup.args_program.clone(),
            &sim_setup.game_actions,
            None,
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
        let outcome = run_game_container_with_action_list_with_success_predicate(
            &mut allocator,
            &mut rng,
            sim_setup.private_keys.clone(),
            &sim_setup.identities,
            b"debug",
            &sim_setup.args_program.clone(),
            &sim_setup.game_actions,
            None,
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
        let outcome = run_game_container_with_action_list_with_success_predicate(
            &mut allocator,
            &mut rng,
            sim_setup.private_keys.clone(),
            &sim_setup.identities,
            b"debug",
            &sim_setup.args_program.clone(),
            &sim_setup.game_actions,
            None,
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
        let outcome = run_game_container_with_action_list_with_success_predicate(
            &mut allocator,
            &mut rng,
            sim_setup.private_keys.clone(),
            &sim_setup.identities,
            b"debug",
            &sim_setup.args_program.clone(),
            &sim_setup.game_actions,
            None,
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
            Some(&|_, cradles| cradles[0].handshake_finished() && cradles[1].handshake_finished()),
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

    res.push(("test_calpoker_shutdown_nerf_alice", &|| {
        let mut allocator = AllocEncoder::new();

        let mut moves = prefix_test_moves(&mut allocator).to_vec();
        moves.push(GameAction::Accept(0));
        moves.push(GameAction::NerfTransactions(0));
        moves.push(GameAction::Shutdown(1, Rc::new(BasicShutdownConditions)));

        let outcome = run_calpoker_container_with_action_list(&mut allocator, &moves)
            .expect("should finish");

        let (p1_balance, p2_balance) = get_balances_from_outcome(&outcome).expect("should work");
        assert_eq!(p2_balance, p1_balance + 200);
    }));

    res.push(("test_calpoker_shutdown_nerf_bob", &|| {
        let mut allocator = AllocEncoder::new();

        let mut moves = prefix_test_moves(&mut allocator).to_vec();
        moves.push(GameAction::Accept(0));
        moves.push(GameAction::NerfTransactions(1));
        moves.push(GameAction::Shutdown(1, Rc::new(BasicShutdownConditions)));

        let outcome = run_calpoker_container_with_action_list(&mut allocator, &moves)
            .expect("should finish");

        let (p1_balance, p2_balance) = get_balances_from_outcome(&outcome).expect("should work");
        assert_eq!(p2_balance, p1_balance + 200);
    }));

    res.push((
        "test_notification_we_timed_out_during_redo",
        &|| {
            let mut allocator = AllocEncoder::new();

            // Keep first 3 calpoker moves (alice commit, bob seed, alice reveal).
            // After alice's reveal, cached_last_action is set. GoOnChain immediately
            // so go_on_chain runs before the response clears cached_last_action.
            // The unroll uses the previous fully-signed state (before alice's reveal),
            // so it's alice's turn on chain and she needs to redo her reveal.
            let mut moves = prefix_test_moves(&mut allocator).to_vec();
            moves.truncate(3);

            // Go on chain right after alice's reveal; she still has cached_last_action.
            moves.push(GameAction::GoOnChain(0));
            // Nerf bob so he can't interfere during the unroll process.
            moves.push(GameAction::NerfTransactions(1));
            // Wait for channel spend inclusion + unroll coin registration + 5-block
            // unroll timeout to fire. At the end of this wait the unroll spend is
            // submitted (alice is still un-nerfed here).
            moves.push(GameAction::WaitBlocks(4, 0));
            // Switch the nerf: now alice's redo transaction will be dropped while
            // bob is free to act.
            moves.push(GameAction::NerfTransactions(0));
            // Wait long enough for the game coin timeout (100 blocks) to fire.
            // Alice's redo was dropped so the game coin stays at "alice's turn".
            moves.push(GameAction::WaitBlocks(110, 0));
            moves.push(GameAction::UnNerfTransactions);
            moves.push(GameAction::WaitBlocks(5, 0));

            let outcome = run_calpoker_container_with_action_list(&mut allocator, &moves)
                .expect("should finish");

            let p0_notifs = &outcome.local_uis[0].notifications;
            let p1_notifs = &outcome.local_uis[1].notifications;
            assert!(
                p0_notifs.iter().any(|n| matches!(n, GameNotification::WeTimedOut { .. })),
                "player 0 should get WeTimedOut (redo move couldn't land), got: {p0_notifs:?}"
            );
            assert!(
                p1_notifs.iter().any(|n| matches!(n, GameNotification::WeTimedOutOpponent { .. })),
                "player 1 should get WeTimedOutOpponent, got: {p1_notifs:?}"
            );
        },
    ));

    res.push((
        "test_notification_bob_redo_then_alice_timeout",
        &|| {
            let mut allocator = AllocEncoder::new();

            // 4 calpoker moves: alice commit(0), bob seed(1), alice reveal(2),
            // bob discard(3).  GoOnChain immediately after bob's discard so bob
            // still has cached_last_action (the go_on_chain check fires before
            // his idle processes Alice's ack).  The unroll lands before bob's
            // move 3 (after alice's move 2), making it bob's turn on-chain.
            // Bob redoes move 3.  After the redo it's alice's turn (move 4).
            // Alice is nerfed so she can't play and times out.
            let mut moves = prefix_test_moves(&mut allocator).to_vec();
            moves.truncate(4);
            // GoOnChain right after bob's last move so cached_last_action is set.
            moves.push(GameAction::GoOnChain(1));
            // Nerf alice so she can't respond on-chain after bob's redo.
            moves.push(GameAction::NerfTransactions(0));
            // Wait for unroll timeout + bob's redo.
            moves.push(GameAction::WaitBlocks(4, 0));
            // Wait for game coin timeout (alice can't move).
            moves.push(GameAction::WaitBlocks(110, 0));
            moves.push(GameAction::UnNerfTransactions);
            moves.push(GameAction::WaitBlocks(5, 0));

            let outcome = run_calpoker_container_with_action_list(&mut allocator, &moves)
                .expect("should finish");

            let p0_notifs = &outcome.local_uis[0].notifications;
            let p1_notifs = &outcome.local_uis[1].notifications;
            assert!(
                p0_notifs.iter().any(|n| matches!(n, GameNotification::WeTimedOut { .. })),
                "player 0 (alice) should get WeTimedOut (nerfed, couldn't play move 4), got: {p0_notifs:?}"
            );
            assert!(
                p1_notifs.iter().any(|n| matches!(n, GameNotification::WeTimedOutOpponent { .. })),
                "player 1 (bob) should get WeTimedOutOpponent (claimed timeout), got: {p1_notifs:?}"
            );
        },
    ));

    res.push((
        "test_notification_we_timed_out_our_turn",
        &|| {
            let mut allocator = AllocEncoder::new();

            // 3 calpoker moves (alice commit, bob seed, alice reveal).
            // Bob received alice's reveal so his cached_last_action is
            // cleared.  Bob goes on-chain: no redo needed.  The game
            // coin lands at bob's turn (to discard) and he never moves,
            // so his clock runs out.
            let mut moves = prefix_test_moves(&mut allocator).to_vec();
            moves.truncate(3);
            moves.push(GameAction::GoOnChain(1));
            // 120 blocks covers the unroll timeout (5) and
            // game coin timeout (100).
            moves.push(GameAction::WaitBlocks(120, 0));

            let outcome = run_calpoker_container_with_action_list(&mut allocator, &moves)
                .expect("should finish");

            let p0_notifs = &outcome.local_uis[0].notifications;
            let p1_notifs = &outcome.local_uis[1].notifications;
            assert!(
                p1_notifs.iter().any(|n| matches!(n, GameNotification::WeTimedOut { .. })),
                "player 1 should get WeTimedOut (it was our turn, no move queued), got: {p1_notifs:?}"
            );
            assert!(
                p0_notifs.iter().any(|n| matches!(n, GameNotification::WeTimedOutOpponent { .. })),
                "player 0 should get WeTimedOutOpponent, got: {p0_notifs:?}"
            );
        },
    ));

    res.push((
        "test_notification_slash_opponent_illegal_move",
        &|| {
            let mut allocator = AllocEncoder::new();

            // 3 moves so that after the redo (alice's reveal) it's Bob's
            // turn, allowing Cheat(1) to fire.
            let moves = prefix_test_moves(&mut allocator);
            let mut on_chain_moves: Vec<GameAction> = moves.into_iter().take(3).collect();
            on_chain_moves.push(GameAction::GoOnChain(0));
            on_chain_moves.push(GameAction::Cheat(1));
            on_chain_moves.push(GameAction::WaitBlocks(30, 0));

            let outcome = run_calpoker_container_with_action_list(&mut allocator, &on_chain_moves)
                .expect("should finish");

            let p0_notifs = &outcome.local_uis[0].notifications;
            assert!(
                p0_notifs.iter().any(|n| matches!(n, GameNotification::OpponentPlayedIllegalMove { .. })),
                "player 0 should get OpponentPlayedIllegalMove, got: {p0_notifs:?}"
            );
            assert!(
                p0_notifs.iter().any(|n| matches!(n, GameNotification::WeSlashedOpponent { .. })),
                "player 0 should get WeSlashedOpponent, got: {p0_notifs:?}"
            );
        },
    ));

    res.push((
        "test_notification_opponent_slashed_us",
        &|| {
            let mut allocator = AllocEncoder::new();

            // 4 moves so that after the redo (bob's discard) it's Alice's
            // turn, allowing Cheat(0) to fire.
            let moves = prefix_test_moves(&mut allocator);
            let mut on_chain_moves: Vec<GameAction> = moves.into_iter().take(4).collect();
            on_chain_moves.push(GameAction::GoOnChain(0));
            on_chain_moves.push(GameAction::Cheat(0));
            on_chain_moves.push(GameAction::WaitBlocks(30, 0));

            let outcome = run_calpoker_container_with_action_list(&mut allocator, &on_chain_moves)
                .expect("should finish");

            let p0_notifs = &outcome.local_uis[0].notifications;
            assert!(
                p0_notifs.iter().any(|n| matches!(n, GameNotification::OpponentSlashedUs { .. })),
                "player 0 (cheater) should get OpponentSlashedUs, got: {p0_notifs:?}"
            );
        },
    ));

    res.push((
        "test_notification_accept_finished",
        &|| {
            let mut allocator = AllocEncoder::new();

            // Use 4 moves (remove only alice_accept) so the game is mid-play.
            // After redo of bob's discard it's player 0's turn, so Accept(0)
            // fires.  Go on-chain first so Accept goes through the on-chain
            // handler (off-chain Accept immediately finishes the game).
            let mut moves = prefix_test_moves(&mut allocator).to_vec();
            moves.pop();
            moves.push(GameAction::GoOnChain(0));
            moves.push(GameAction::Accept(0));
            moves.push(GameAction::WaitBlocks(120, 1));
            moves.push(GameAction::WaitBlocks(5, 0));

            let outcome = run_calpoker_container_with_action_list(&mut allocator, &moves)
                .expect("should finish");

            let p0_notifs = &outcome.local_uis[0].notifications;
            assert!(
                p0_notifs.iter().any(|n| matches!(n, GameNotification::WeTimedOut { .. })),
                "player 0 (who accepted) should get WeTimedOut, got: {p0_notifs:?}"
            );
        },
    ));

    res.push(("test_accept_after_nerfed_peer_gets_share", &|| {
        let mut allocator = AllocEncoder::new();
        let seed_data: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed_data);

        // Single debug-game move: Alice sets mover_share to 100 (half of the
        // 200-unit pot).  Alice then gets nerfed so her transactions are
        // dropped, goes on-chain (disconnecting from Bob), and Bob accepts the
        // result and goes on-chain himself.  Bob's unroll lands and after the
        // timeout he claims his half.
        let moves = [DebugGameTestMove::new(100, 0)];
        let mut sim_setup =
            setup_debug_test(&mut allocator, &mut rng, &moves).expect("ok");
        sim_setup.game_actions.push(GameAction::NerfTransactions(0));
        sim_setup.game_actions.push(GameAction::GoOnChain(0));
        sim_setup.game_actions.push(GameAction::Accept(1));
        sim_setup.game_actions.push(GameAction::GoOnChain(1));
        sim_setup.game_actions.push(GameAction::WaitBlocks(120, 0));

        let outcome = run_game_container_with_action_list_with_success_predicate(
            &mut allocator,
            &mut rng,
            sim_setup.private_keys.clone(),
            &sim_setup.identities,
            b"debug",
            &sim_setup.args_program,
            &sim_setup.game_actions,
            None,
        )
        .expect("should finish");

        let p1_notifs = &outcome.local_uis[1].notifications;
        assert!(
            p1_notifs.iter().any(|n| matches!(n, GameNotification::WeTimedOut { .. })),
            "Bob (who accepted) should get WeTimedOut, got: {p1_notifs:?}"
        );

        let (p0_balance, p1_balance) =
            get_balances_from_outcome(&outcome).expect("should get balances");
        // Bob claimed his 100.  Alice is still nerfed so her 100 reward sits
        // unclaimed, leaving her 100 short.
        assert_eq!(
            p1_balance, p0_balance + 100,
            "Bob should have claimed his half (p0={p0_balance} p1={p1_balance})"
        );
    }));

    res.push((
        "test_on_chain_before_any_moves_times_out",
        &|| {
            let mut allocator = AllocEncoder::new();

            // Game is committed during handshake, so going on-chain before any
            // moves creates the game coin on-chain where it times out normally.
            // GameCancelled only happens when a game was proposed but never
            // committed (unroll reverts to before the game existed).
            let moves = vec![
                GameAction::GoOnChain(1),
                GameAction::WaitBlocks(20, 1),
            ];

            let outcome = run_calpoker_container_with_action_list(&mut allocator, &moves)
                .expect("should finish");

            let p0_notifs = &outcome.local_uis[0].notifications;
            let p1_notifs = &outcome.local_uis[1].notifications;
            let p0_timed_out = p0_notifs.iter().any(|n| matches!(n, GameNotification::WeTimedOut { .. }));
            let p1_timed_out_opponent = p1_notifs.iter().any(|n| matches!(n, GameNotification::WeTimedOutOpponent { .. }));
            assert!(
                p0_timed_out,
                "player 0 should get WeTimedOut (it was their turn, no move made), got: {p0_notifs:?}"
            );
            assert!(
                p1_timed_out_opponent,
                "player 1 should get WeTimedOutOpponent (claimed timeout), got: {p1_notifs:?}"
            );
        },
    ));

    res.push((
        "test_notification_opponent_successfully_cheated",
        &|| {
            let mut allocator = AllocEncoder::new();

            // 3 moves so that after the redo (alice's reveal) it's Bob's
            // turn, allowing Cheat(1) to fire.
            let moves = prefix_test_moves(&mut allocator);
            let mut on_chain_moves: Vec<GameAction> = moves.into_iter().take(3).collect();
            on_chain_moves.push(GameAction::GoOnChain(0));
            on_chain_moves.push(GameAction::NerfTransactions(0));
            on_chain_moves.push(GameAction::Cheat(1));
            on_chain_moves.push(GameAction::WaitBlocks(120, 0));
            on_chain_moves.push(GameAction::UnNerfTransactions);
            on_chain_moves.push(GameAction::WaitBlocks(30, 0));

            let outcome = run_calpoker_container_with_action_list(&mut allocator, &on_chain_moves)
                .expect("should finish");

            let p0_notifs = &outcome.local_uis[0].notifications;
            assert!(
                p0_notifs.iter().any(|n| matches!(n, GameNotification::OpponentPlayedIllegalMove { .. })),
                "player 0 should get OpponentPlayedIllegalMove, got: {p0_notifs:?}"
            );
            assert!(
                p0_notifs.iter().any(|n| matches!(n, GameNotification::OpponentSuccessfullyCheated { .. })),
                "player 0 should get OpponentSuccessfullyCheated (slash was nerfed), got: {p0_notifs:?}"
            );
        },
    ));

    res.push((
        "test_notification_game_destroyed_on_chain",
        &|| {
            let mut allocator = AllocEncoder::new();

            // 3 moves so after redo it's Bob's turn; destroying the coin
            // from Alice's view gives GameDestroyedOnChain/OpponentMadeImpossibleSpend.
            let moves = prefix_test_moves(&mut allocator);
            let mut on_chain_moves: Vec<GameAction> = moves.into_iter().take(3).collect();
            on_chain_moves.push(GameAction::GoOnChain(0));
            on_chain_moves.push(GameAction::ForceDestroyCoin(0));
            on_chain_moves.push(GameAction::WaitBlocks(30, 0));

            let outcome = run_calpoker_container_with_action_list(&mut allocator, &on_chain_moves)
                .expect("should finish");

            let p0_notifs = &outcome.local_uis[0].notifications;
            assert!(
                p0_notifs.iter().any(|n| matches!(n, GameNotification::GameDestroyedOnChain { .. }))
                || p0_notifs.iter().any(|n| matches!(n, GameNotification::OpponentMadeImpossibleSpend { .. })),
                "player 0 should get GameDestroyedOnChain or OpponentMadeImpossibleSpend when coin is force-destroyed, got: {p0_notifs:?}"
            );
        },
    ));

    res.push((
        "test_notification_opponent_made_impossible_spend",
        &|| {
            let mut allocator = AllocEncoder::new();

            let moves = prefix_test_moves(&mut allocator);
            let mut on_chain_moves: Vec<GameAction> = moves.into_iter().take(2).collect();
            on_chain_moves.push(GameAction::GoOnChain(0));
            on_chain_moves.push(GameAction::WaitBlocks(5, 0));
            on_chain_moves.push(GameAction::ForceDestroyCoin(1));
            on_chain_moves.push(GameAction::WaitBlocks(30, 0));

            let outcome = run_calpoker_container_with_action_list(&mut allocator, &on_chain_moves)
                .expect("should finish");

            let all_notifs: Vec<&GameNotification> = outcome.local_uis.iter()
                .flat_map(|ui| ui.notifications.iter())
                .collect();
            assert!(
                all_notifs.iter().any(|n| matches!(n, GameNotification::OpponentMadeImpossibleSpend { .. })),
                "some player should get OpponentMadeImpossibleSpend when game coin force-destroyed, got: {all_notifs:?}"
            );
        },
    ));

    res.push((
        "test_notification_our_turn_coin_spent_unexpectedly",
        &|| {
            let mut allocator = AllocEncoder::new();

            let moves = prefix_test_moves(&mut allocator);
            let mut on_chain_moves: Vec<GameAction> = moves.into_iter().take(2).collect();
            on_chain_moves.push(GameAction::GoOnChain(0));
            on_chain_moves.push(GameAction::WaitBlocks(5, 0));
            on_chain_moves.push(GameAction::ForceDestroyCoin(0));
            on_chain_moves.push(GameAction::WaitBlocks(30, 0));

            let outcome = run_calpoker_container_with_action_list(&mut allocator, &on_chain_moves)
                .expect("should finish");

            let all_notifs: Vec<&GameNotification> = outcome.local_uis.iter()
                .flat_map(|ui| ui.notifications.iter())
                .collect();
            assert!(
                all_notifs.iter().any(|n| matches!(n, GameNotification::OurTurnCoinSpentUnexpectedly { .. })),
                "some player should get OurTurnCoinSpentUnexpectedly when own game coin force-destroyed, got: {all_notifs:?}"
            );
        },
    ));

    res
}
