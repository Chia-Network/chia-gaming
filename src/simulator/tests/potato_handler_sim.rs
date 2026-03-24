use std::borrow::Borrow;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use clvm_traits::ToClvm;
use clvmr::NodePtr;
use rand::prelude::*;
use rand_chacha::ChaCha8Rng;

use crate::channel_handler::types::{ChannelHandlerEnv, ChannelHandlerPrivateKeys, ReadableMove};
use crate::common::constants::{CREATE_COIN, SINGLETON_LAUNCHER_HASH};
use crate::common::standard_coin::{
    sign_agg_sig_me, solution_for_conditions, standard_solution_partial, ChiaIdentity,
};
use crate::common::types::{atom_from_clvm, i64_from_atom, usize_from_atom};
use crate::common::types::{
    AllocEncoder, Amount, CoinSpend, CoinString, Error, GameID, GameType, IntoErr, PrivateKey,
    Program, PuzzleHash, Sha256tree, Spend, SpendBundle, Timeout, ToQuotedProgram,
};
use crate::games::poker_collection;
use crate::peer_container::{
    report_coin_changes_to_peer, FullCoinSetAdapter, GameCradle, MessagePeerQueue, MessagePipe,
    PeerHandler, SynchronousGameCradle, SynchronousGameCradleConfig, WatchEntry, WatchReport,
};
use crate::potato_handler::effects::{
    apply_effects, ChannelState, CradleEvent, Effect, GameNotification,
};
use crate::potato_handler::start::GameStart;
use crate::potato_handler::types::{
    BatchAction, BootstrapTowardWallet, PacketSender, PeerMessage, ToLocalUI, WalletSpendInterface,
};
use crate::potato_handler::PotatoHandler;
use crate::utils::proper_list;

use crate::simulator::Simulator;
use crate::test_support::calpoker::{calpoker_ran_all_the_moves_predicate, prefix_test_moves};
use crate::test_support::debug_game::{make_debug_games, DebugGameCurry};
use crate::test_support::game::{GameAction, ProposeTrigger};
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
pub fn update_and_report_coins<'a>(
    allocator: &mut AllocEncoder,
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
            let mut env = ChannelHandlerEnv::new(allocator).expect("should work");
            let reported_effects =
                report_coin_changes_to_peer(&mut env, &mut peers[who], &watch_report)?;
            apply_effects(reported_effects, allocator, &mut pipes[who])?;
        }
    }

    Ok(watch_report)
}

fn handle_received_channel_puzzle_hash(
    env: &mut ChannelHandlerEnv<'_>,
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
    .map(|effect| effect.into_iter().collect::<Vec<_>>())
}

fn build_wallet_bundle_for_request(
    allocator: &mut AllocEncoder,
    simulator: &Simulator,
    identity: &ChiaIdentity,
    request: &crate::potato_handler::handshake::CoinSpendRequest,
) -> Result<SpendBundle, Error> {
    let mut candidate_coins = simulator.get_my_coins(&identity.puzzle_hash)?;
    candidate_coins.retain(|coin| {
        coin.to_parts()
            .map(|(_, _, amt)| amt.to_u64() >= request.amount.to_u64())
            .unwrap_or(false)
    });
    let selected_coin = if let Some(expected_coin_id) = request.coin_id.as_ref() {
        candidate_coins
            .into_iter()
            .find(|coin| coin.to_coin_id() == *expected_coin_id)
            .ok_or_else(|| {
                Error::StrErr(format!(
                    "no spendable coin for requested coin_id {expected_coin_id:?}"
                ))
            })?
    } else {
        candidate_coins
            .into_iter()
            .min_by_key(|coin| {
                coin.to_parts()
                    .map(|(_, _, amt)| amt.to_u64())
                    .unwrap_or(u64::MAX)
            })
            .ok_or_else(|| Error::StrErr("no spendable coin for coin spend request".to_string()))?
    };
    let mut create_targets: Vec<(PuzzleHash, Amount)> = Vec::new();
    if request.coin_id.is_some() {
        create_targets.push((
            PuzzleHash::from_bytes(SINGLETON_LAUNCHER_HASH),
            Amount::default(),
        ));
    }

    let env = ChannelHandlerEnv::new(allocator)?;
    let clvm_conditions: Vec<(u32, (PuzzleHash, (Amount, ())))> = create_targets
        .iter()
        .map(|(ph, amt)| (CREATE_COIN, (ph.clone(), (amt.clone(), ()))))
        .collect();
    let conditions_clvm = clvm_conditions.to_clvm(env.allocator).into_gen()?;
    let spend = standard_solution_partial(
        env.allocator,
        &identity.synthetic_private_key,
        &selected_coin.to_coin_id(),
        conditions_clvm,
        &identity.synthetic_public_key,
        &env.agg_sig_me_additional_data,
        false,
    )?;

    Ok(SpendBundle {
        name: Some("wallet coin spend request".to_string()),
        spends: vec![CoinSpend {
            coin: selected_coin,
            bundle: Spend {
                puzzle: identity.puzzle.clone(),
                solution: spend.solution.clone(),
                signature: spend.signature.clone(),
            },
        }],
    })
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
        self.simulated_wallet_spend
            .register_coin(coin_id, timeout, name)
    }

    fn request_puzzle_and_solution(&mut self, _coin_id: &CoinString) -> Result<(), Error> {
        Err(Error::StrErr(
            "request_puzzle_and_solution not expected during handshake".to_string(),
        ))
    }
}

impl BootstrapTowardWallet for SimulatedPeer {
    fn channel_puzzle_hash(&mut self, puzzle_hash: &PuzzleHash) -> Result<(), Error> {
        self.channel_puzzle_hash = Some(puzzle_hash.clone());
        Ok(())
    }

    fn received_channel_offer(&mut self, bundle: &SpendBundle) -> Result<(), Error> {
        self.unfunded_offer = Some(bundle.clone());
        Ok(())
    }
}

impl ToLocalUI for SimulatedPeer {
    fn notification(&mut self, notification: &GameNotification) -> Result<(), Error> {
        match notification {
            GameNotification::GameMessage { readable, .. } => {
                self.messages.push(readable.clone());
                Ok(())
            }
            GameNotification::OpponentMoved { .. } => Ok(()),
            GameNotification::ChannelStatus { state, .. } => {
                use crate::potato_handler::effects::ChannelState;
                match state {
                    ChannelState::Unrolling
                    | ChannelState::ResolvedUnrolled
                    | ChannelState::ResolvedStale
                    | ChannelState::Failed => Err(Error::StrErr(format!(
                        "unexpected channel status during handshake: {state:?}"
                    ))),
                    _ => Ok(()),
                }
            }
            _ => Ok(()),
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn handshake(
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

        run_move(allocator, Amount::new(200), pipes, &mut peers[who], who).expect("should send");

        if let Some(ph) = pipes[who].channel_puzzle_hash.clone() {
            pipes[who].channel_puzzle_hash = None;
            let reported_effects = {
                let mut env = ChannelHandlerEnv::new(allocator).expect("should work");
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
            let reported_effect = {
                let mut env = ChannelHandlerEnv::new(allocator).expect("should work");
                peers[who].channel_transaction_completion(&mut env, &u)?
            };
            if let Some(effect) = reported_effect {
                apply_effects(vec![effect], allocator, &mut pipes[who])?;
            }

            let env = ChannelHandlerEnv::new(allocator).expect("should work");
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
            let included_result = simulator.push_tx(env.allocator, &spends.spends)?;

            pipes[who].unfunded_offer = None;
            assert_eq!(included_result.code, 1);

            simulator.farm_block(&identities[who].puzzle_hash);
            simulator.farm_block(&identities[who].puzzle_hash);

            update_and_report_coins(allocator, coinset_adapter, peers, pipes, simulator)?;
        }

        if !pipes[who].outbound_transactions.is_empty() {
            panic!(
                "unexpected outbound transactions during handshake for peer {who}: {:?}",
                pipes[who].outbound_transactions
            );
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

#[derive(Debug, Clone)]
pub enum TestEvent {
    OpponentMoved {
        id: GameID,
        state_number: usize,
        readable: ReadableMove,
        mover_share: Amount,
    },
    GameMessage {
        id: GameID,
        readable: ReadableMove,
    },
    Notification(GameNotification),
}

#[derive(Debug, Clone, PartialEq)]
pub enum ExpectedNotification {
    WeTimedOut,
    OpponentTimedOut,
    GameCancelled,
    OpponentPlayedIllegalMove,
    WeSlashedOpponent,
    OpponentSlashedUs,
    OpponentSuccessfullyCheated,
    WeMoved,
    GameOnChain,
    GameError,
    GameProposed,
    GameProposalAccepted,
    GameProposalCancelled,
    InsufficientBalance,
    ChannelState(ChannelState),
}

#[derive(Debug, Clone, PartialEq)]
pub enum ExpectedEvent {
    OpponentMoved { mover_share: Amount },
    GameMessage,
    Notification(ExpectedNotification),
}

fn event_matches(actual: &TestEvent, expected: &ExpectedEvent) -> bool {
    match (actual, expected) {
        (
            TestEvent::OpponentMoved {
                mover_share: a_share,
                ..
            },
            ExpectedEvent::OpponentMoved {
                mover_share: e_share,
            },
        ) => a_share == e_share,
        (TestEvent::GameMessage { .. }, ExpectedEvent::GameMessage) => true,
        (TestEvent::Notification(actual_n), ExpectedEvent::Notification(expected_n)) => {
            match (actual_n, expected_n) {
                (GameNotification::WeTimedOut { .. }, ExpectedNotification::WeTimedOut) => true,
                (
                    GameNotification::OpponentTimedOut { .. },
                    ExpectedNotification::OpponentTimedOut,
                ) => true,
                (GameNotification::GameCancelled { .. }, ExpectedNotification::GameCancelled) => {
                    true
                }
                (
                    GameNotification::OpponentPlayedIllegalMove { .. },
                    ExpectedNotification::OpponentPlayedIllegalMove,
                ) => true,
                (
                    GameNotification::WeSlashedOpponent { .. },
                    ExpectedNotification::WeSlashedOpponent,
                ) => true,
                (
                    GameNotification::OpponentSlashedUs { .. },
                    ExpectedNotification::OpponentSlashedUs,
                ) => true,
                (
                    GameNotification::OpponentSuccessfullyCheated { .. },
                    ExpectedNotification::OpponentSuccessfullyCheated,
                ) => true,
                (GameNotification::WeMoved { .. }, ExpectedNotification::WeMoved) => true,
                (GameNotification::GameOnChain { .. }, ExpectedNotification::GameOnChain) => true,
                (GameNotification::GameError { .. }, ExpectedNotification::GameError) => true,
                (GameNotification::GameProposed { .. }, ExpectedNotification::GameProposed) => true,
                (
                    GameNotification::GameProposalAccepted { .. },
                    ExpectedNotification::GameProposalAccepted,
                ) => true,
                (
                    GameNotification::GameProposalCancelled { .. },
                    ExpectedNotification::GameProposalCancelled,
                ) => true,
                (
                    GameNotification::InsufficientBalance { .. },
                    ExpectedNotification::InsufficientBalance,
                ) => true,
                (
                    GameNotification::ChannelStatus {
                        state: actual_state,
                        ..
                    },
                    ExpectedNotification::ChannelState(expected_state),
                ) => actual_state == expected_state,
                _ => false,
            }
        }
        _ => false,
    }
}

fn event_shape(actual: &TestEvent) -> String {
    match actual {
        TestEvent::OpponentMoved { state_number, mover_share, .. } => format!("OpponentMoved(sn={state_number},share={})", mover_share.to_u64()),
        TestEvent::GameMessage { .. } => "GameMessage".to_string(),
        TestEvent::Notification(n) => match n {
            GameNotification::WeTimedOut { .. } => "Notif(WeTimedOut)".to_string(),
            GameNotification::OpponentTimedOut { .. } => "Notif(OpponentTimedOut)".to_string(),
            GameNotification::GameCancelled { .. } => "Notif(GameCancelled)".to_string(),
            GameNotification::OpponentPlayedIllegalMove { .. } => "Notif(OpponentPlayedIllegalMove)".to_string(),
            GameNotification::WeSlashedOpponent { .. } => "Notif(WeSlashedOpponent)".to_string(),
            GameNotification::OpponentSlashedUs { .. } => "Notif(OpponentSlashedUs)".to_string(),
            GameNotification::OpponentSuccessfullyCheated { .. } => "Notif(OpponentSuccessfullyCheated)".to_string(),
            GameNotification::GameError { .. } => "Notif(GameError)".to_string(),
            GameNotification::GameProposed { id, .. } => format!("Notif(GameProposed(id={id:?}))"),
            GameNotification::GameProposalAccepted { id } => format!("Notif(GameProposalAccepted(id={id:?}))"),
            GameNotification::GameProposalCancelled { id, reason } => format!("Notif(GameProposalCancelled(id={id:?},reason={reason}))"),
            GameNotification::InsufficientBalance { id, our_balance_short, their_balance_short } => format!("Notif(InsufficientBalance(id={id:?},ours={our_balance_short},theirs={their_balance_short}))"),
            GameNotification::WeMoved { .. } => "Notif(WeMoved)".to_string(),
            GameNotification::OpponentMoved { .. } => "Notif(OpponentMoved)".to_string(),
            GameNotification::GameMessage { .. } => "Notif(GameMessage)".to_string(),
            GameNotification::GameOnChain { id, .. } => format!("Notif(GameOnChain(id={id:?}))"),
            GameNotification::ActionFailed { reason } => format!("Notif(ActionFailed(reason={reason}))"),
            GameNotification::ChannelStatus { state, .. } => format!("Notif(ChannelStatus(state={state:?}))"),
        },
    }
}

fn expected_shape(expected: &ExpectedEvent) -> String {
    match expected {
        ExpectedEvent::OpponentMoved { mover_share } => {
            format!("OpponentMoved(share={})", mover_share.to_u64())
        }
        ExpectedEvent::GameMessage => "GameMessage".to_string(),
        ExpectedEvent::Notification(n) => match n {
            ExpectedNotification::WeTimedOut => "Notif(WeTimedOut)".to_string(),
            ExpectedNotification::OpponentTimedOut => "Notif(OpponentTimedOut)".to_string(),
            ExpectedNotification::GameCancelled => "Notif(GameCancelled)".to_string(),
            ExpectedNotification::OpponentPlayedIllegalMove => {
                "Notif(OpponentPlayedIllegalMove)".to_string()
            }
            ExpectedNotification::WeSlashedOpponent => "Notif(WeSlashedOpponent)".to_string(),
            ExpectedNotification::OpponentSlashedUs => "Notif(OpponentSlashedUs)".to_string(),
            ExpectedNotification::OpponentSuccessfullyCheated => {
                "Notif(OpponentSuccessfullyCheated)".to_string()
            }
            ExpectedNotification::WeMoved => "Notif(WeMoved)".to_string(),
            ExpectedNotification::GameOnChain => "Notif(GameOnChain)".to_string(),
            ExpectedNotification::GameError => "Notif(GameError)".to_string(),
            ExpectedNotification::GameProposed => "Notif(GameProposed)".to_string(),
            ExpectedNotification::GameProposalAccepted => "Notif(GameProposalAccepted)".to_string(),
            ExpectedNotification::GameProposalCancelled => {
                "Notif(GameProposalCancelled)".to_string()
            }
            ExpectedNotification::InsufficientBalance => "Notif(InsufficientBalance)".to_string(),
            ExpectedNotification::ChannelState(s) => format!("Notif(ChannelStatus(state={s:?}))"),
        },
    }
}

pub fn game_proposed() -> ExpectedEvent {
    ExpectedEvent::Notification(ExpectedNotification::GameProposed)
}

pub fn game_accepted() -> ExpectedEvent {
    ExpectedEvent::Notification(ExpectedNotification::GameProposalAccepted)
}

pub fn assert_event_sequence(events: &[TestEvent], expected: &[ExpectedEvent], player_label: &str) {
    let actual_shapes: Vec<String> = events.iter().map(event_shape).collect();
    let expected_shapes: Vec<String> = expected.iter().map(expected_shape).collect();

    if events.len() != expected.len() {
        panic!(
            "{player_label}: event count mismatch: got {} events, expected {}.\n  actual:   {actual_shapes:?}\n  expected: {expected_shapes:?}",
            events.len(),
            expected.len(),
        );
    }

    for (i, (actual, exp)) in events.iter().zip(expected.iter()).enumerate() {
        if !event_matches(actual, exp) {
            panic!(
                "{player_label}: event {i} mismatch.\n  actual:   {}\n  expected: {}\n  full actual:   {actual_shapes:?}\n  full expected: {expected_shapes:?}",
                event_shape(actual),
                expected_shape(exp),
            );
        }
    }
}

/// Validates consistency of `reward_coin` across all notifications:
/// - When `reward_coin` is `Some`, it must be a parseable `CoinString` with amount > 0.
/// - `our_reward > 0` ↔ `reward_coin.is_some()` for all notification types that
///   carry both fields.
pub fn assert_reward_coin_consistency(notifications: &[GameNotification], label: &str) {
    for n in notifications {
        match n {
            GameNotification::WeTimedOut {
                our_reward,
                reward_coin,
                ..
            }
            | GameNotification::OpponentTimedOut {
                our_reward,
                reward_coin,
                ..
            }
            | GameNotification::OpponentSuccessfullyCheated {
                our_reward,
                reward_coin,
                ..
            } => {
                if let Some(rc) = reward_coin {
                    let parts = rc.to_parts();
                    assert!(
                        parts.is_some(),
                        "{label}: reward_coin is Some but not parseable: {n:?}"
                    );
                    let (_, _, amt) = parts.unwrap();
                    assert!(
                        amt > Amount::default(),
                        "{label}: reward_coin is Some but amount is zero: {n:?}"
                    );
                }
                let has_reward = *our_reward > Amount::default();
                let has_coin = reward_coin.is_some();
                assert_eq!(
                    has_reward, has_coin,
                    "{label}: our_reward/reward_coin mismatch (has_reward={has_reward}, has_coin={has_coin}): {n:?}"
                );
            }
            GameNotification::WeSlashedOpponent { .. } => {
                // reward_coin is CoinString (not Option); may be default if
                // no reward coin was found. No structural assertion here.
            }

            _ => {}
        }
    }
}

#[derive(Default, Debug)]
pub struct LocalTestUIReceiver {
    pub channel_created: bool,
    pub clean_shutdown_complete: bool,
    pub go_on_chain: bool,
    pub got_error: bool,
    pub opponent_moves: Vec<(GameID, usize, ReadableMove, Amount)>,
    pub opponent_messages: Vec<OpponentMessageInfo>,
    pub notifications: Vec<GameNotification>,
    pub events: Vec<TestEvent>,
    pub proposed_game_ids: Vec<GameID>,
    pub accepted_proposal_ids: Vec<GameID>,
    pub received_proposal_ids: Vec<GameID>,
    pub game_accepted_ids: HashSet<GameID>,
    pub opponent_moved_in_game: HashSet<GameID>,
    pub game_finished_ids: HashSet<GameID>,
}

impl LocalTestUIReceiver {
    fn assert_channel_created(&self, method: &str) {
        assert!(
            self.channel_created,
            "ToLocalUI::{method} called before channel_created notification"
        );
    }

    /// True when every accepted game has exactly one terminal game notification (same notion as
    /// post-run invariants). Vacuously true if there are no `GameProposalAccepted` games.
    pub fn all_accepted_games_have_terminal_notification(&self) -> bool {
        let accepted_ids: HashSet<GameID> = self
            .notifications
            .iter()
            .filter_map(|n| {
                if let GameNotification::GameProposalAccepted { id } = n {
                    Some(id.clone())
                } else {
                    None
                }
            })
            .collect();
        for id in accepted_ids {
            let terminal_count = self
                .notifications
                .iter()
                .filter(|n| match n {
                    GameNotification::InsufficientBalance { id: nid, .. } => nid == &id,
                    GameNotification::GameCancelled { id: nid } => nid == &id,
                    GameNotification::WeTimedOut { id: nid, .. } => nid == &id,
                    GameNotification::OpponentTimedOut { id: nid, .. } => nid == &id,
                    GameNotification::WeSlashedOpponent { id: nid, .. } => nid == &id,
                    GameNotification::OpponentSlashedUs { id: nid } => nid == &id,
                    GameNotification::OpponentSuccessfullyCheated { id: nid, .. } => nid == &id,
                    GameNotification::GameError { id: nid, .. } => nid == &id,
                    _ => false,
                })
                .count();
            if terminal_count != 1 {
                return false;
            }
        }
        true
    }
}

impl ToLocalUI for LocalTestUIReceiver {
    fn notification(&mut self, notification: &GameNotification) -> Result<(), Error> {
        match notification {
            GameNotification::ChannelStatus {
                state: ChannelState::Active,
                ..
            } => {
                self.channel_created = true;
            }
            GameNotification::OpponentMoved {
                id,
                state_number,
                readable,
                mover_share,
            } => {
                self.assert_channel_created("opponent_moved");
                self.opponent_moved_in_game.insert(id.clone());
                self.opponent_moves.push((
                    id.clone(),
                    *state_number,
                    readable.clone(),
                    mover_share.clone(),
                ));
                self.events.push(TestEvent::OpponentMoved {
                    id: id.clone(),
                    state_number: *state_number,
                    readable: readable.clone(),
                    mover_share: mover_share.clone(),
                });
            }
            GameNotification::GameProposed { id, .. } => {
                self.assert_channel_created("game_proposed");
                self.received_proposal_ids.push(id.clone());
                self.notifications.push(notification.clone());
                self.events
                    .push(TestEvent::Notification(notification.clone()));
            }
            GameNotification::GameProposalAccepted { id } => {
                self.assert_channel_created("game_proposal_accepted");
                self.game_accepted_ids.insert(id.clone());
                self.notifications.push(notification.clone());
                self.events
                    .push(TestEvent::Notification(notification.clone()));
            }
            GameNotification::WeTimedOut { id, .. }
            | GameNotification::OpponentTimedOut { id, .. }
            | GameNotification::WeSlashedOpponent { id, .. }
            | GameNotification::OpponentSlashedUs { id }
            | GameNotification::OpponentSuccessfullyCheated { id, .. }
            | GameNotification::GameCancelled { id, .. }
            | GameNotification::GameError { id, .. } => {
                self.assert_channel_created("game_terminal");
                self.game_finished_ids.insert(id.clone());
                self.notifications.push(notification.clone());
                self.events
                    .push(TestEvent::Notification(notification.clone()));
            }
            GameNotification::GameMessage { id, readable } => {
                self.assert_channel_created("game_message");
                self.opponent_messages.push(OpponentMessageInfo {
                    opponent_move_size: self.opponent_moves.len(),
                    opponent_message: readable.clone(),
                });
                self.events.push(TestEvent::GameMessage {
                    id: id.clone(),
                    readable: readable.clone(),
                });
            }
            GameNotification::ChannelStatus { state, .. } => {
                if matches!(state, ChannelState::Active) {
                    self.channel_created = true;
                }
                if matches!(
                    state,
                    ChannelState::ShuttingDown
                        | ChannelState::ResolvedClean
                        | ChannelState::ResolvedUnrolled
                        | ChannelState::ResolvedStale
                        | ChannelState::Failed
                ) {
                    self.assert_channel_created("channel_status");
                }
                if matches!(state, ChannelState::ResolvedClean) {
                    self.clean_shutdown_complete = true;
                }
                if matches!(
                    state,
                    ChannelState::Unrolling | ChannelState::ResolvedStale | ChannelState::Failed
                ) {
                    self.go_on_chain = true;
                    self.got_error = true;
                }
                self.notifications.push(notification.clone());
                if matches!(
                    state,
                    ChannelState::Unrolling
                        | ChannelState::ShuttingDown
                        | ChannelState::ResolvedClean
                        | ChannelState::ResolvedUnrolled
                        | ChannelState::ResolvedStale
                        | ChannelState::Failed
                ) {
                    self.events
                        .push(TestEvent::Notification(notification.clone()));
                }
            }
            other => {
                self.assert_channel_created("game_notification");
                self.notifications.push(other.clone());
                self.events.push(TestEvent::Notification(other.clone()));
            }
        }
        Ok(())
    }
}

type GameRunEarlySuccessPredicate<'a> = Option<&'a dyn Fn(usize, &[SynchronousGameCradle]) -> bool>;

pub struct GameRunOutcome {
    pub identities: [ChiaIdentity; 2],
    pub cradles: [SynchronousGameCradle; 2],
    pub local_uis: [LocalTestUIReceiver; 2],
    pub simulator: Simulator,
    pub debug_logs: [Vec<String>; 2],
}

fn reports_blocked(i: usize, blocked: &Option<(usize, usize)>) -> bool {
    if let Some((_, players)) = blocked {
        return players & (1 << i) != 0;
    }

    false
}

fn gid_diag_enabled() -> bool {
    std::env::var("SIM_GID_DIAG").is_ok()
}

fn gid_diag(test_name: &str, action_idx: usize, label: &str, requested: &GameID, runtime: &GameID) {
    eprintln!(
        "GID-DIAG test={test_name} action={action_idx} op={label} requested={:?} runtime={:?}",
        requested, runtime
    );
}

fn move_ready(moves: &[GameAction], mn: usize, local_uis: &[LocalTestUIReceiver; 2]) -> bool {
    if mn >= moves.len() {
        return false;
    }
    match &moves[mn] {
        GameAction::Move(who, gid, _, _) | GameAction::FakeMove(who, gid, _, _) => {
            local_uis[*who].game_accepted_ids.contains(gid)
                || local_uis[*who].opponent_moved_in_game.contains(gid)
        }
        _ => false,
    }
}

fn accept_resolved(local_uis: &[LocalTestUIReceiver; 2], who: usize, gid: &GameID) -> bool {
    local_uis[who].game_accepted_ids.contains(gid)
        || local_uis[who].notifications.iter().any(|n| {
            matches!(n,
                GameNotification::InsufficientBalance { id, .. }
                | GameNotification::GameCancelled { id }
                | GameNotification::GameProposalCancelled { id, .. }
                    if id == gid
            )
        })
}

fn accept_proposal_ready(
    moves: &[GameAction],
    mn: usize,
    local_uis: &[LocalTestUIReceiver; 2],
) -> bool {
    if mn >= moves.len() {
        return false;
    }
    if let GameAction::AcceptProposal(who, gid) = &moves[mn] {
        if local_uis[*who].accepted_proposal_ids.contains(gid) {
            accept_resolved(local_uis, *who, gid)
        } else {
            local_uis[*who].received_proposal_ids.contains(gid)
        }
    } else {
        false
    }
}

fn propose_ready(moves: &[GameAction], mn: usize, local_uis: &[LocalTestUIReceiver; 2]) -> bool {
    if mn >= moves.len() {
        return false;
    }
    match &moves[mn] {
        GameAction::ProposeNewGame(who, trigger)
        | GameAction::ProposeNewGameTheirTurn(who, trigger) => match trigger {
            ProposeTrigger::Channel => local_uis[*who].channel_created,
            ProposeTrigger::AfterGame(gid) => {
                local_uis[0].game_finished_ids.contains(gid)
                    || local_uis[1].game_finished_ids.contains(gid)
            }
        },
        _ => false,
    }
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
    per_player_balance: Option<u64>,
) -> Result<GameRunOutcome, Error> {
    let bal = per_player_balance.unwrap_or(100);
    let mut move_number = 0;
    let gid_diag_on = gid_diag_enabled();
    let test_name = crate::simulator::current_test_name().unwrap_or_else(|| "unknown".to_string());
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

    let coins0 = simulator.get_my_coins(&identities[0].puzzle_hash)?;
    let coins1 = simulator.get_my_coins(&identities[1].puzzle_hash)?;

    let (parent_coin_0, _rest_0) = simulator.transfer_coin_amount(
        allocator,
        &identities[0].puzzle_hash,
        &identities[0],
        &coins0[0],
        Amount::new(bal),
    )?;
    let (parent_coin_1, _rest_1) = simulator.transfer_coin_amount(
        allocator,
        &identities[1].puzzle_hash,
        &identities[1],
        &coins1[0],
        Amount::new(bal),
    )?;
    let launcher_coin = CoinString::from_parts(
        &parent_coin_0.to_coin_id(),
        &PuzzleHash::from_bytes(SINGLETON_LAUNCHER_HASH),
        &Amount::default(),
    );

    simulator.farm_block(&neutral_identity.puzzle_hash);

    let cradle1 = SynchronousGameCradle::new_with_keys(
        SynchronousGameCradleConfig {
            game_types: game_type_map.clone(),
            have_potato: true,
            identity: identities[0].clone(),
            my_contribution: Amount::new(bal),
            their_contribution: Amount::new(bal),
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
            my_contribution: Amount::new(bal),
            their_contribution: Amount::new(bal),
            channel_timeout: Timeout::new(100),
            unroll_timeout: Timeout::new(5),
            reward_puzzle_hash: identities[1].puzzle_hash.clone(),
        },
        private_keys[1].clone(),
    );
    let mut cradles = [cradle1, cradle2];
    let mut handshake_done = false;
    let mut can_move = false;
    let mut ending = None;

    let mut wait_blocks = None;
    let mut report_backlogs = [Vec::default(), Vec::default()];
    let mut force_destroyed_coins: Vec<CoinString> = Vec::new();
    let mut nerf_transactions_for: u8 = 0;
    let mut nerfed_tx_backlog: Vec<SpendBundle> = Vec::new();
    let mut nerf_messages_for: u8 = 0;
    let mut start_step = 0;
    let mut num_steps = 0;
    let mut debug_logs: [Vec<String>; 2] = [Vec::new(), Vec::new()];

    // Give coins to the cradles.
    cradles[0].opening_coin(allocator, parent_coin_0)?;
    cradles[1].opening_coin(allocator, parent_coin_1)?;

    let global_move = |moves: &[GameAction], move_number: usize| {
        move_number < moves.len()
            && matches!(
                &moves[move_number],
                GameAction::CleanShutdown(_)
                    | GameAction::WaitBlocks(_, _)
                    | GameAction::GoOnChain(_)
                    | GameAction::GoOnChainThenMove(_)
                    | GameAction::AcceptTimeout(_, _)
                    | GameAction::Timeout(_)
                    | GameAction::Cheat(_, _, _)
                    | GameAction::ForceDestroyCoin(_, _)
                    | GameAction::NerfTransactions(_)
                    | GameAction::UnNerfTransactions(_)
                    | GameAction::CancelProposal(_, _)
                    | GameAction::CorruptStateNumber(_, _)
                    | GameAction::ForceUnroll(_)
                    | GameAction::NerfMessages(_)
                    | GameAction::UnNerfMessages
                    | GameAction::SaveUnrollSnapshot(_)
                    | GameAction::ForceStaleUnroll(_)
                    | GameAction::InjectRawMessage(_, _)
            )
    };
    let has_explicit_go_on_chain = moves_input.iter().any(|m| {
        matches!(
            m,
            GameAction::GoOnChain(_)
                | GameAction::GoOnChainThenMove(_)
                | GameAction::ForceUnroll(_)
                | GameAction::ForceStaleUnroll(_)
        )
    });

    let timing_enabled = std::env::var("SIM_TIMING").is_ok();
    let mut step_start = std::time::Instant::now();

    while !matches!(ending, Some(0)) {
        num_steps += 1;

        let handshake_flags = [
            cradles[0].handshake_finished(),
            cradles[1].handshake_finished(),
        ];
        let channel_created_flags = [local_uis[0].channel_created, local_uis[1].channel_created];
        let need_launcher = [
            cradles[0].need_launcher_coin(),
            cradles[1].need_launcher_coin(),
        ];
        let need_coin_spend = [
            cradles[0].requested_coin_spend().is_some(),
            cradles[1].requested_coin_spend().is_some(),
        ];
        assert!(
            num_steps < 200,
            "simulation stalled: num_steps={num_steps} move_number={move_number} can_move={can_move} next_action={:?} explicit_go_on_chain={has_explicit_go_on_chain} handshake_finished={handshake_flags:?} channel_created={channel_created_flags:?} need_launcher={need_launcher:?} need_coin_spend={need_coin_spend:?}",
            moves_input.get(move_number)
        );

        if matches!(wait_blocks, Some((0, _))) {
            wait_blocks = None;
        }

        let t0 = std::time::Instant::now();
        simulator.farm_block(&neutral_identity.puzzle_hash);
        let current_height = simulator.get_current_height();
        let current_coins = simulator.get_all_coins().expect("should work");
        let mut watch_report = coinset_adapter
            .make_report_from_coin_set_update(current_height as u64, &current_coins)?;
        if timing_enabled {
            let farm_elapsed = t0.elapsed();
            eprintln!("  step {num_steps}: farm_block+report {farm_elapsed:.2?}");
        }

        for coin in force_destroyed_coins.drain(..) {
            watch_report.deleted_watched.insert(coin);
        }

        if let Some(p) = &pred {
            if p(move_number, &cradles) {
                return Ok(GameRunOutcome {
                    identities: [identities[0].clone(), identities[1].clone()],
                    cradles,
                    local_uis,
                    simulator,
                    debug_logs,
                });
            }
        }

        for i in 0..=1 {
            if local_uis[i].go_on_chain && cradles[i].is_on_chain() {
                local_uis[i].go_on_chain = false;
            } else if local_uis[i].go_on_chain && cradles[i].handshake_finished() {
                if !has_explicit_go_on_chain && !local_uis[i].got_error {
                    panic!(
                        "unexpected off-chain->on-chain transition in non-on-chain test: player={i} move_number={move_number} got_error={} next_action={:?}",
                        local_uis[i].got_error,
                        moves_input.get(move_number)
                    );
                }
                local_uis[i].go_on_chain = false;
                let got_error = local_uis[i].got_error;
                cradles[i].go_on_chain(allocator, &mut local_uis[i], got_error)?;
            }

            if reports_blocked(i, &wait_blocks) {
                report_backlogs[i].push((current_height, watch_report.clone()));
            } else {
                let t_nb = std::time::Instant::now();
                cradles[i].new_block(allocator, current_height, &watch_report)?;
                if timing_enabled {
                    let nb_elapsed = t_nb.elapsed();
                    if nb_elapsed.as_millis() > 10 {
                        eprintln!("  step {num_steps}: p{i} new_block {nb_elapsed:.2?}");
                    }
                }
            }

            {
                let mut result = cradles[i].drain_all(allocator)?;
                if i == 0 && cradles[i].need_launcher_coin() {
                    cradles[i].provide_launcher_coin(allocator, launcher_coin.clone())?;
                    let follow_up = cradles[i].drain_all(allocator)?;
                    if result.resync.is_none() {
                        result.resync = follow_up.resync;
                    }
                    result.events.extend(follow_up.events);
                }
                if let Some(req) = cradles[i].requested_coin_spend() {
                    let wallet_bundle = build_wallet_bundle_for_request(
                        allocator,
                        &simulator,
                        &identities[i],
                        &req,
                    )?;
                    cradles[i].provide_coin_spend_bundle(allocator, wallet_bundle)?;
                    let follow_up = cradles[i].drain_all(allocator)?;
                    if result.resync.is_none() {
                        result.resync = follow_up.resync;
                    }
                    result.events.extend(follow_up.events);
                }

                // Collect coin solution requests from this drain and all
                // subsequent drains they trigger, processing every other
                // event inline in FIFO order.
                let mut pending_events = result.events;
                if matches!(result.resync, Some((_, true))) {
                    can_move = true;
                    let saved = move_number;
                    while move_number > 0
                        && (move_number >= moves_input.len()
                            || !matches!(moves_input[move_number], GameAction::Move(_, _, _, _)))
                    {
                        move_number -= 1;
                    }
                    let dominated_by_other = match moves_input.get(move_number) {
                        Some(GameAction::Move(who, _, _, _)) => *who != i,
                        _ => true,
                    };
                    if dominated_by_other {
                        move_number = saved;
                    }
                }

                loop {
                    let mut coin_requests = Vec::new();
                    for event in pending_events.iter() {
                        match event {
                            CradleEvent::OutboundTransaction(tx) => {
                                if nerf_transactions_for & (1 << i) != 0 {
                                    nerfed_tx_backlog.push(tx.clone());
                                    continue;
                                }
                                let all_unspendable = tx
                                    .spends
                                    .iter()
                                    .all(|cs| !simulator.is_coin_spendable(&cs.coin));
                                if all_unspendable {
                                    continue;
                                }
                                let t_tx = std::time::Instant::now();
                                let included_result = simulator.push_tx(allocator, &tx.spends)?;
                                if timing_enabled {
                                    let tx_elapsed = t_tx.elapsed();
                                    if tx_elapsed.as_millis() > 10 {
                                        eprintln!(
                                            "  step {num_steps}: p{i} push_tx({:?}) {tx_elapsed:.2?}",
                                            tx.name
                                        );
                                    }
                                }
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
                            CradleEvent::OutboundMessage(msg) => {
                                if nerf_messages_for & (1 << i) != 0 {
                                    continue;
                                }
                                if cradles[i].is_peer_disconnected() {
                                    continue;
                                }
                                let t_msg = std::time::Instant::now();
                                cradles[i ^ 1].deliver_message(msg)?;
                                if timing_enabled {
                                    let msg_elapsed = t_msg.elapsed();
                                    if msg_elapsed.as_millis() > 10 {
                                        eprintln!(
                                            "  step {num_steps}: p{i}->p{} deliver_message {msg_elapsed:.2?}",
                                            i ^ 1
                                        );
                                    }
                                }
                            }
                            CradleEvent::Notification(n) => {
                                local_uis[i].notification(n)?;
                            }
                            CradleEvent::ReceiveError(e) => {
                                eprintln!("SIM receive error p{i}: {e}");
                                local_uis[i].notification(&GameNotification::ChannelStatus {
                                    state: ChannelState::Failed,
                                    advisory: Some(format!("error receiving peer message: {e}")),
                                    coin: None,
                                    our_balance: None,
                                    their_balance: None,
                                    game_allocated: None,
                                })?;
                            }
                            CradleEvent::CoinSolutionRequest(coin) => {
                                coin_requests.push(coin.clone());
                            }
                            CradleEvent::DebugLog(line) => {
                                debug_logs[i].push(line.clone());
                            }
                        }
                    }

                    if coin_requests.is_empty() {
                        break;
                    }
                    for coin in coin_requests.iter() {
                        let ps_res = simulator
                            .get_puzzle_and_solution(&coin.to_coin_id())
                            .expect("should work");
                        for (_ci, cradle) in cradles.iter_mut().enumerate() {
                            cradle.report_puzzle_and_solution(
                                allocator,
                                coin,
                                ps_res.as_ref().map(|ps| (&ps.0, &ps.1)),
                            )?;
                        }
                    }
                    let follow_up = cradles[i].drain_all(allocator)?;
                    pending_events = follow_up.events;
                }
            }
        }

        if timing_enabled {
            let step_elapsed = step_start.elapsed();
            if step_elapsed.as_millis() > 50 {
                eprintln!(
                    "  step {num_steps} TOTAL: {step_elapsed:.2?} (move_number={move_number})"
                );
            }
        }
        step_start = std::time::Instant::now();

        let should_end = cradles.iter().enumerate().all(|(i, c)| {
            c.channel_status_terminal()
                && local_uis[i].all_accepted_games_have_terminal_notification()
        }) && ending.is_none();
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

            handshake_done = true;
        }

        if let Some((wb, _)) = &mut wait_blocks {
            #[allow(clippy::needless_range_loop)]
            for i in 0..=1 {
                for (current_height, watch_report) in report_backlogs[i].iter() {
                    cradles[i].new_block(allocator, *current_height, watch_report)?;
                }
                report_backlogs[i].clear();
            }
            if *wb > 0 {
                *wb -= 1;
            };
        } else if can_move
            || global_move(moves_input, move_number)
            || move_ready(moves_input, move_number, &local_uis)
            || accept_proposal_ready(moves_input, move_number, &local_uis)
            || propose_ready(moves_input, move_number, &local_uis)
        {
            can_move = false;

            if move_number < moves_input.len() {
                let ga = &moves_input[move_number];
                move_number += 1;
                let action_idx = move_number - 1;

                match ga {
                    GameAction::Move(who, gid, readable, _share) => {
                        if gid_diag_on {
                            gid_diag(&test_name, action_idx, "Move", gid, gid);
                        }
                        let entropy = rng.gen();
                        let t_mv = std::time::Instant::now();
                        cradles[*who].make_move(allocator, gid, readable.clone(), entropy)?;
                        if timing_enabled {
                            let mv_elapsed = t_mv.elapsed();
                            eprintln!("  step {num_steps}: p{who} make_move(move_number={move_number}) {mv_elapsed:.2?}");
                        }
                        local_uis[*who].game_accepted_ids.remove(gid);
                        local_uis[*who].opponent_moved_in_game.remove(gid);
                    }
                    GameAction::ProposeNewGame(who, _trigger)
                    | GameAction::ProposeNewGameTheirTurn(who, _trigger) => {
                        let my_turn = matches!(ga, GameAction::ProposeNewGame(_, _));
                        let new_ids = cradles[*who].propose_game(
                            allocator,
                            &GameStart {
                                amount: Amount::new(200),
                                my_contribution: Amount::new(100),
                                game_type: GameType(game_type.to_vec()),
                                timeout: Timeout::new(10),
                                my_turn,
                                parameters: extras.clone(),
                            },
                        )?;
                        local_uis[*who]
                            .proposed_game_ids
                            .extend(new_ids.iter().cloned());
                    }
                    GameAction::AcceptProposal(who, gid) => {
                        if gid_diag_on {
                            gid_diag(&test_name, action_idx, "AcceptProposal", gid, gid);
                        }
                        if !local_uis[*who].accepted_proposal_ids.contains(gid) {
                            cradles[*who].accept_proposal(allocator, gid)?;
                            local_uis[*who].accepted_proposal_ids.push(*gid);
                            move_number -= 1;
                        }
                    }
                    GameAction::CancelProposal(who, gid) => {
                        if gid_diag_on {
                            gid_diag(&test_name, action_idx, "CancelProposal", gid, gid);
                        }
                        cradles[*who].cancel_proposal(allocator, gid)?;
                    }
                    GameAction::GoOnChain(who) => {
                        assert!(
                            !cradles[*who].channel_status_terminal(),
                            "GameAction::GoOnChain({who}) but channel is already terminal: move_number={move_number} notifications={:?}",
                            local_uis[*who].notifications
                        );
                        if cradles[*who].is_on_chain() {
                            panic!(
                                "GameAction::GoOnChain({who}) but player is already on chain: move_number={move_number}",
                            );
                        }
                        if !cradles[*who].handshake_finished() {
                            move_number -= 1;
                            continue;
                        }
                        local_uis[*who].go_on_chain = true;
                    }
                    GameAction::GoOnChainThenMove(who) => {
                        if !cradles[*who].handshake_finished() {
                            move_number -= 1;
                            continue;
                        }

                        local_uis[*who].go_on_chain = true;
                        let got_error = local_uis[*who].got_error;
                        cradles[*who].go_on_chain(allocator, &mut local_uis[*who], got_error)?;
                        local_uis[*who].go_on_chain = false;

                        let next = moves_input.get(move_number);
                        if let Some(GameAction::Move(mwho, gid, readable, _)) = next {
                            assert_eq!(
                                *mwho, *who,
                                "GoOnChainThenMove({who}) followed by Move({mwho},...) — player mismatch"
                            );
                            if gid_diag_on {
                                gid_diag(
                                    &test_name,
                                    move_number,
                                    "GoOnChainThenMove/Move",
                                    gid,
                                    gid,
                                );
                            }
                            let entropy = rng.gen();
                            cradles[*who].make_move(allocator, gid, readable.clone(), entropy)?;
                            move_number += 1;
                        } else {
                            panic!(
                                "GoOnChainThenMove({who}) must be followed by a Move action, got {next:?}"
                            );
                        }
                    }
                    GameAction::FakeMove(who, gid, readable, move_data) => {
                        if gid_diag_on {
                            gid_diag(&test_name, action_idx, "FakeMove", gid, gid);
                        }
                        let entropy = rng.gen();
                        cradles[*who].make_move(allocator, gid, readable.clone(), entropy)?;
                        // Flush pending actions into the events queue
                        // (without draining) so replace_last_message can
                        // find the outbound batch.
                        cradles[*who].flush_pending(allocator)?;
                        local_uis[*who].game_accepted_ids.remove(gid);
                        local_uis[*who].opponent_moved_in_game.remove(gid);

                        cradles[*who].replace_last_message(|msg_envelope| {
                            if let PeerMessage::Batch { actions, signatures, clean_shutdown } = msg_envelope {
                                let mut new_actions = actions.clone();
                                let mut found = false;
                                for action in new_actions.iter_mut() {
                                    if let BatchAction::Move(_game_id, ref mut gmd) = action {
                                        gmd.basic.move_made.append(&mut move_data.clone());
                                        found = true;
                                        break;
                                    }
                                }
                                if !found {
                                    return Err(Error::StrErr(format!(
                                        "FakeMove sabotage: no BatchAction::Move found in {msg_envelope:?}"
                                    )));
                                }
                                Ok(PeerMessage::Batch {
                                    actions: new_actions,
                                    signatures: signatures.clone(),
                                    clean_shutdown: clean_shutdown.clone(),
                                })
                            } else {
                                Err(Error::StrErr(format!(
                                    "FakeMove sabotage expected PeerMessage::Batch, got {msg_envelope:?}"
                                )))
                            }
                        })?;
                    }
                    GameAction::Cheat(who, gid, cheat_share) => {
                        if gid_diag_on {
                            gid_diag(&test_name, action_idx, "Cheat", gid, gid);
                        }
                        cradles[*who].cheat(allocator, gid, cheat_share.clone())?;
                    }
                    GameAction::ForceDestroyCoin(who, gid) => {
                        if gid_diag_on {
                            gid_diag(&test_name, action_idx, "ForceDestroyCoin", gid, gid);
                        }
                        if let Some(game_coin) = cradles[*who].get_game_coin(gid) {
                            force_destroyed_coins.push(game_coin);
                        } else {
                            move_number -= 1;
                            continue;
                        }
                    }
                    GameAction::NerfTransactions(who) => {
                        nerf_transactions_for |= 1 << *who;
                    }
                    GameAction::UnNerfTransactions(replay) => {
                        nerf_transactions_for = 0;
                        if *replay {
                            for tx in nerfed_tx_backlog.drain(..) {
                                let any_stale = tx
                                    .spends
                                    .iter()
                                    .any(|cs| !simulator.is_coin_spendable(&cs.coin));
                                if any_stale {
                                    continue;
                                }
                                simulator.push_tx(allocator, &tx.spends)?;
                            }
                        } else {
                            nerfed_tx_backlog.clear();
                        }
                    }
                    GameAction::NerfMessages(who) => {
                        nerf_messages_for |= 1 << *who;
                    }
                    GameAction::UnNerfMessages => {
                        nerf_messages_for = 0;
                    }
                    GameAction::WaitBlocks(n, players) => {
                        wait_blocks = Some((*n, *players));
                    }
                    GameAction::AcceptTimeout(who, gid) => {
                        if gid_diag_on {
                            gid_diag(&test_name, action_idx, "AcceptTimeout", gid, gid);
                        }
                        cradles[*who].accept_timeout(allocator, gid)?;
                    }
                    GameAction::Timeout(_who) => {
                        panic!("Timeout action is not supported in sim tests; use AcceptTimeout(player, game_id)");
                    }
                    GameAction::CleanShutdown(who) => {
                        assert!(
                            !cradles[*who].is_on_chain(),
                            "CleanShutdown({who}) called while on chain; on-chain completion is automatic"
                        );
                        if !cradles[*who].handshake_finished() {
                            move_number -= 1;
                            continue;
                        }
                        cradles[*who].shut_down(allocator)?;
                    }
                    GameAction::CorruptStateNumber(who, new_sn) => {
                        cradles[*who].corrupt_state_for_testing(*new_sn)?;
                    }
                    GameAction::ForceUnroll(who) => {
                        let spend = cradles[*who].force_unroll_spend(allocator)?;
                        simulator.push_tx(allocator, &spend.spends)?;
                    }
                    GameAction::SaveUnrollSnapshot(who) => {
                        cradles[*who].save_unroll_snapshot();
                    }
                    GameAction::ForceStaleUnroll(who) => {
                        let spend = cradles[*who].force_stale_unroll_spend(allocator)?;
                        let _included_result = simulator.push_tx(allocator, &spend.spends)?;
                    }
                    GameAction::InjectRawMessage(who, data) => {
                        cradles[*who].deliver_message(data)?;
                    }
                }
            }
        }
    }

    for (i, lui) in local_uis.iter().enumerate() {
        assert!(
            lui.channel_created,
            "player {i} never received channel_created notification"
        );
    }

    // Invariant 1: proposal-sent — every propose_game call yields exactly one
    // GameProposalAccepted or GameProposalCancelled.
    for (i, lui) in local_uis.iter().enumerate() {
        for id in lui.proposed_game_ids.iter() {
            let accepted = lui
                .notifications
                .iter()
                .filter(|n| {
                    matches!(n,
                        GameNotification::GameProposalAccepted { id: nid } if nid == id
                    )
                })
                .count();
            let cancelled = lui
                .notifications
                .iter()
                .filter(|n| {
                    matches!(n,
                        GameNotification::GameProposalCancelled { id: nid, .. } if nid == id
                    )
                })
                .count();
            assert!(
                accepted + cancelled == 1,
                "player {i}: propose_game({id:?}) should have exactly one \
                 Accepted or Cancelled, got {accepted} accepted + {cancelled} cancelled.\n\
                 All notifications: {:?}",
                lui.notifications
            );
        }
    }

    // Invariant 2: proposal-received — every GameProposed notification yields
    // exactly one GameProposalAccepted or GameProposalCancelled.
    for (i, lui) in local_uis.iter().enumerate() {
        for n in lui.notifications.iter() {
            if let GameNotification::GameProposed { id, .. } = n {
                let accepted = lui
                    .notifications
                    .iter()
                    .filter(|n2| {
                        matches!(n2,
                            GameNotification::GameProposalAccepted { id: nid } if nid == id
                        )
                    })
                    .count();
                let cancelled = lui
                    .notifications
                    .iter()
                    .filter(|n2| {
                        matches!(n2,
                            GameNotification::GameProposalCancelled { id: nid, .. } if nid == id
                        )
                    })
                    .count();
                assert!(
                    accepted + cancelled == 1,
                    "player {i}: GameProposed({id:?}) should have exactly one \
                     Accepted or Cancelled, got {accepted} accepted + {cancelled} cancelled.\n\
                     All notifications: {:?}",
                    lui.notifications
                );
            }
        }
    }

    // Invariant 3: accept-call — every AcceptProposal call yields exactly one
    // terminal game notification.
    for (i, lui) in local_uis.iter().enumerate() {
        for id in lui.accepted_proposal_ids.iter() {
            let terminal_count = lui
                .notifications
                .iter()
                .filter(|n| match n {
                    GameNotification::InsufficientBalance { id: nid, .. } => nid == id,
                    GameNotification::GameCancelled { id: nid } => nid == id,
                    GameNotification::WeTimedOut { id: nid, .. } => nid == id,
                    GameNotification::OpponentTimedOut { id: nid, .. } => nid == id,
                    GameNotification::WeSlashedOpponent { id: nid, .. } => nid == id,
                    GameNotification::OpponentSlashedUs { id: nid } => nid == id,
                    GameNotification::OpponentSuccessfullyCheated { id: nid, .. } => nid == id,
                    GameNotification::GameError { id: nid, .. } => nid == id,
                    _ => false,
                })
                .count();
            assert!(
                terminal_count == 1,
                "player {i}: AcceptProposal({id:?}) should have exactly one terminal notification, got {terminal_count}. All notifications: {:?}",
                lui.notifications,
            );
        }
    }

    // Invariant 4: post-acceptance — every GameProposalAccepted yields exactly
    // one terminal game notification.
    for (i, lui) in local_uis.iter().enumerate() {
        for n in lui.notifications.iter() {
            if let GameNotification::GameProposalAccepted { id } = n {
                let terminal_count = lui
                    .notifications
                    .iter()
                    .filter(|n2| match n2 {
                        GameNotification::WeTimedOut { id: nid, .. } => nid == id,
                        GameNotification::OpponentTimedOut { id: nid, .. } => nid == id,
                        GameNotification::WeSlashedOpponent { id: nid, .. } => nid == id,
                        GameNotification::OpponentSlashedUs { id: nid } => nid == id,
                        GameNotification::OpponentSuccessfullyCheated { id: nid, .. } => nid == id,
                        GameNotification::GameCancelled { id: nid } => nid == id,
                        GameNotification::GameError { id: nid, .. } => nid == id,
                        _ => false,
                    })
                    .count();
                assert!(
                    terminal_count == 1,
                    "player {i}: GameProposalAccepted({id:?}) should have exactly one terminal game notification, got {terminal_count}. All notifications: {:?}",
                    lui.notifications,
                );
            }
        }
    }

    // Invariant 5: GameOnChain only for accepted games.
    for (i, lui) in local_uis.iter().enumerate() {
        let accepted_ids: HashSet<GameID> = lui
            .notifications
            .iter()
            .filter_map(|n| {
                if let GameNotification::GameProposalAccepted { id } = n {
                    Some(id.clone())
                } else {
                    None
                }
            })
            .collect();
        for n in &lui.notifications {
            if let GameNotification::GameOnChain { id, .. } = n {
                assert!(
                    accepted_ids.contains(id),
                    "player {i}: GameOnChain({id:?}) but no GameProposalAccepted for that game. \
                     Accepted IDs: {accepted_ids:?}\nAll notifications: {:?}",
                    lui.notifications,
                );
            }
        }
    }

    // Invariant 6: channel state monotonicity.
    fn channel_state_ordinal(s: &ChannelState) -> u8 {
        match s {
            ChannelState::Handshaking => 0,
            ChannelState::TransactionSubmitted => 1,
            ChannelState::Active => 2,
            ChannelState::ShuttingDown => 3,
            ChannelState::Unrolling => 4,
            ChannelState::ResolvedClean
            | ChannelState::ResolvedUnrolled
            | ChannelState::ResolvedStale
            | ChannelState::Failed => 5,
        }
    }
    for (i, lui) in local_uis.iter().enumerate() {
        let mut last_state: Option<ChannelState> = None;
        for n in &lui.notifications {
            if let GameNotification::ChannelStatus { state, .. } = n {
                let ord = channel_state_ordinal(state);
                if let Some(ref prev) = last_state {
                    let prev_ord = channel_state_ordinal(prev);
                    if ord < prev_ord {
                        panic!(
                            "player {i}: channel state went backwards: {prev:?}({prev_ord}) -> {state:?}({ord})\n\
                             All notifications: {:?}",
                            lui.notifications,
                        );
                    }
                    if ord == prev_ord && ord != 2 && ord != 5 {
                        panic!(
                            "player {i}: non-terminal same-ordinal repeat: {prev:?}({prev_ord}) -> {state:?}({ord})\n\
                             All notifications: {:?}",
                            lui.notifications,
                        );
                    }
                }
                last_state = Some(state.clone());
            }
        }
    }

    Ok(GameRunOutcome {
        identities: [identities[0].clone(), identities[1].clone()],
        cradles,
        local_uis,
        simulator,
        debug_logs,
    })
}

pub fn run_calpoker_container_with_action_list_with_success_predicate(
    allocator: &mut AllocEncoder,
    moves: &[GameAction],
    predicate: GameRunEarlySuccessPredicate,
    per_player_balance: Option<u64>,
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
        per_player_balance,
    )
}

pub fn run_calpoker_container_with_action_list(
    allocator: &mut AllocEncoder,
    moves: &[GameAction],
) -> Result<GameRunOutcome, Error> {
    run_calpoker_container_with_action_list_with_success_predicate(allocator, moves, None, None)
}

pub fn run_calpoker_proposal_only(
    allocator: &mut AllocEncoder,
    moves: &[GameAction],
    predicate: GameRunEarlySuccessPredicate,
    per_player_balance: Option<u64>,
) -> Result<GameRunOutcome, Error> {
    run_calpoker_container_with_action_list_with_success_predicate(
        allocator,
        moves,
        predicate,
        per_player_balance,
    )
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

pub fn parse_card_lists_from_readable(
    allocator: &mut AllocEncoder,
    readable: ReadableMove,
) -> Result<(Vec<usize>, Vec<usize>), Error> {
    let nodeptr = readable.to_nodeptr(allocator)?;
    let list = proper_list(allocator.allocator(), nodeptr, true)
        .ok_or_else(|| Error::StrErr("expected list of card lists".to_string()))?;
    if list.len() != 2 {
        return Err(Error::StrErr(format!(
            "expected 2 card lists, got {}",
            list.len()
        )));
    }
    let mut result = Vec::new();
    for &card_list_node in &list {
        let cards: Vec<usize> = proper_list(allocator.allocator(), card_list_node, true)
            .unwrap_or_default()
            .iter()
            .filter_map(|n| atom_from_clvm(allocator, *n).and_then(|a| usize_from_atom(&a)))
            .filter(|n| *n < 52)
            .collect();
        result.push(cards);
    }
    Ok((result.remove(0), result.remove(0)))
}

fn parse_win_direction_from_readable(
    allocator: &mut AllocEncoder,
    readable_node: NodePtr,
    is_alice: bool,
) -> Result<i64, Error> {
    let list = proper_list(allocator.allocator(), readable_node, true)
        .ok_or_else(|| Error::StrErr("expected readable list".to_string()))?;
    if list.len() < 6 {
        return Err(Error::StrErr("readable too short".to_string()));
    }
    let mut win_dir = atom_from_clvm(allocator, list[5])
        .and_then(|a| i64_from_atom(&a))
        .unwrap_or_default();
    if is_alice {
        win_dir = -win_dir;
    }
    Ok(win_dir)
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

    for (_pn, lui) in outcome.local_uis.iter().enumerate() {
        for (_mn, the_move) in lui.opponent_moves.iter().enumerate() {
            let _ = the_move.2.to_nodeptr(allocator).expect("should work");
        }
    }

    let alice_cards = parse_card_lists_from_readable(allocator, p0_view_of_cards.2.clone())
        .expect("should get cards from p0 view");
    let bob_cards = parse_card_lists_from_readable(allocator, p1_view_of_cards.2.clone())
        .expect("should get cards from p1 view");
    assert_eq!(
        alice_cards, bob_cards,
        "both players should see the same dealt cards"
    );

    let bob_outcome_node = bob_outcome_move
        .2
        .to_nodeptr(allocator)
        .expect("should work");
    let bob_win_dir = parse_win_direction_from_readable(allocator, bob_outcome_node, false)
        .expect("should parse bob win direction");

    let alice_outcome_node = alice_outcome_move
        .2
        .to_nodeptr(allocator)
        .expect("should work");
    let _alice_win_dir = parse_win_direction_from_readable(allocator, alice_outcome_node, true)
        .expect("should parse alice win direction");

    if bob_win_dir == 1 {
        assert_eq!(p1_balance + 200, p2_balance);
    } else if bob_win_dir == -1 {
        assert_eq!(p2_balance + 200, p1_balance);
    } else {
        assert_eq!(p2_balance, p1_balance);
    }
}

pub struct DebugGameSimSetup {
    pub private_keys: [ChannelHandlerPrivateKeys; 2],
    pub identities: [ChiaIdentity; 2],
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

pub fn add_debug_test_accept_shutdown(test_setup: &mut DebugGameSimSetup, wait: usize, who: usize) {
    test_setup
        .game_actions
        .push(GameAction::AcceptTimeout(who, GameID(1)));
    test_setup
        .game_actions
        .push(GameAction::WaitBlocks(wait, 0));
    test_setup
        .game_actions
        .push(GameAction::WaitBlocks(wait, 1));
    test_setup.game_actions.push(GameAction::CleanShutdown(1));
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

    // Player 0 (have_potato=true) allocates odd nonces in this harness.
    // The first proposal from player 0 is therefore GameID(1).
    let first_game_nonce: usize = 1;
    let mut debug_games = make_debug_games(allocator, rng, &private_identities, first_game_nonce)?;

    let mut game_actions = Vec::new();
    game_actions.push(GameAction::ProposeNewGame(0, ProposeTrigger::Channel));
    game_actions.push(GameAction::AcceptProposal(
        1,
        GameID(first_game_nonce as u64),
    ));

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

        game_actions.push(GameAction::Move(
            i % 2,
            GameID(first_game_nonce as u64),
            the_move.ui_move.clone(),
            true,
        ));
    }

    let args_curry = DebugGameCurry::new(
        allocator,
        &debug_games[0].alice_identity.public_key,
        &debug_games[0].bob_identity.public_key,
    );
    let args = args_curry.expect("good").to_clvm(allocator).into_gen()?;
    let args_program = Rc::new(Program::from_nodeptr(allocator, args).expect("ok"));

    Ok(DebugGameSimSetup {
        private_keys,
        identities,
        game_actions,
        args_program,
    })
}

pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
    let mut res: Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> = Vec::new();
    res.push(("test_peer_in_sim", &|| {
        let mut allocator = AllocEncoder::new();

        // Play moves
        let mut moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
        ];
        moves.extend(prefix_test_moves(&mut allocator, GameID(1)));
        let outcome = run_calpoker_container_with_action_list_with_success_predicate(
            &mut allocator,
            &moves,
            Some(&calpoker_ran_all_the_moves_predicate(moves.len())),
            None,
        )
        .expect("this is a test");

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
            ],
            "peer_in_sim p0",
        );
        assert_event_sequence(
            &outcome.local_uis[1].events,
            &[
                game_proposed(),
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::GameMessage,
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
            ],
            "peer_in_sim p1",
        );
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

            let mut moves = vec![
                GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
                GameAction::AcceptProposal(1, GameID(1)),
            ];
            moves.extend(prefix_test_moves(&mut allocator, GameID(1)));
            if let GameAction::Move(player, game_id, readable, _) = moves[5].clone() {
                moves.insert(
                    5,
                    GameAction::FakeMove(player, game_id, readable, vec![0; 500]),
                );
            } else {
                panic!("no move 5 to replace");
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
                None,
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

            assert_event_sequence(
                &outcome.local_uis[0].events,
                &[
                    game_accepted(),
                    ExpectedEvent::OpponentMoved {
                        mover_share: Amount::new(0),
                    },
                    ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                        ChannelState::Unrolling,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                        ChannelState::ResolvedUnrolled,
                    )),
                ],
                "piss_off_basic p0",
            );
            assert_event_sequence(
                &outcome.local_uis[1].events,
                &[
                    game_proposed(),
                    game_accepted(),
                    ExpectedEvent::OpponentMoved {
                        mover_share: Amount::new(0),
                    },
                    ExpectedEvent::GameMessage,
                    ExpectedEvent::OpponentMoved {
                        mover_share: Amount::new(0),
                    },
                    ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                        ChannelState::Unrolling,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                        ChannelState::ResolvedUnrolled,
                    )),
                ],
                "piss_off_basic p1",
            );
        },
    ));

    res.push(("sim_test_with_peer_container_off_chain_complete", &|| {
        let mut allocator = AllocEncoder::new();

        let mut moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
        ];
        moves.extend(prefix_test_moves(&mut allocator, GameID(1)));
        moves.push(GameAction::CleanShutdown(1));
        let outcome =
            run_calpoker_container_with_action_list(&mut allocator, &moves).expect("should finish");

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

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::OpponentTimedOut),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ShuttingDown,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedClean,
                )),
            ],
            "off_chain_complete p0",
        );
        assert_event_sequence(
            &outcome.local_uis[1].events,
            &[
                game_proposed(),
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::GameMessage,
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(200),
                },
                ExpectedEvent::Notification(ExpectedNotification::WeTimedOut),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ShuttingDown,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedClean,
                )),
            ],
            "off_chain_complete p1",
        );
        assert!(
            outcome.local_uis[0].clean_shutdown_complete,
            "p0 should reach ResolvedClean"
        );
        assert!(
            outcome.local_uis[1].clean_shutdown_complete,
            "p1 should reach ResolvedClean"
        );
    }));

    res.push((
        "sim_test_with_peer_container_piss_off_peer_complete",
        &|| {
            let mut allocator = AllocEncoder::new();

            let mut moves = vec![
                GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
                GameAction::AcceptProposal(1, GameID(1)),
            ];
            moves.extend(prefix_test_moves(&mut allocator, GameID(1)));
            if let GameAction::Move(player, game_id, readable, _) = moves[5].clone() {
                moves.insert(
                    5,
                    GameAction::FakeMove(player, game_id, readable, vec![0; 500]),
                );
                moves.remove(6);
            } else {
                panic!("no move 5 to replace");
            }
            // After the remaining moves execute on-chain, let both players
            // process blocks so the game resolves via timeout.
            moves.push(GameAction::WaitBlocks(120, 0));
            // No explicit GoOnChain needed: the fake move error forces player 0
            // on chain, and player 1 detects the channel coin spend and follows.
            let outcome = run_calpoker_container_with_action_list(&mut allocator, &moves)
                .unwrap_or_else(|e| panic!("should finish, got error: {e:?}"));
            // The fake move should have forced player 0 on chain via error detection.
            assert!(
                outcome.local_uis[0].got_error,
                "player 0 should have been forced on chain by the fake move error"
            );

            let (p1_balance, p2_balance) =
                get_balances_from_outcome(&outcome).expect("should get balances");
            assert!(
                p1_balance > 0 && p2_balance > 0,
                "both players should have non-zero balance after game"
            );

            assert_event_sequence(
                &outcome.local_uis[0].events,
                &[
                    game_accepted(),
                    ExpectedEvent::OpponentMoved {
                        mover_share: Amount::new(0),
                    },
                    ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                        ChannelState::Unrolling,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                        ChannelState::ResolvedUnrolled,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                    ExpectedEvent::OpponentMoved {
                        mover_share: Amount::new(0),
                    },
                    ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                    ExpectedEvent::Notification(ExpectedNotification::WeMoved),
                    ExpectedEvent::Notification(ExpectedNotification::OpponentTimedOut),
                ],
                "piss_off_complete p0",
            );
            assert_event_sequence(
                &outcome.local_uis[1].events,
                &[
                    game_proposed(),
                    game_accepted(),
                    ExpectedEvent::OpponentMoved {
                        mover_share: Amount::new(0),
                    },
                    ExpectedEvent::GameMessage,
                    ExpectedEvent::OpponentMoved {
                        mover_share: Amount::new(0),
                    },
                    ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                        ChannelState::Unrolling,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                        ChannelState::ResolvedUnrolled,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                    ExpectedEvent::Notification(ExpectedNotification::WeMoved),
                    ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                    ExpectedEvent::OpponentMoved {
                        mover_share: Amount::new(200),
                    },
                    ExpectedEvent::Notification(ExpectedNotification::WeTimedOut),
                ],
                "piss_off_complete p1",
            );
        },
    ));

    res.push((
        "sim_test_with_peer_container_piss_off_peer_after_start_complete",
        &|| {
            let mut allocator = AllocEncoder::new();

            let moves = vec![
                GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
                GameAction::AcceptProposal(1, GameID(1)),
                GameAction::GoOnChain(1),
                GameAction::WaitBlocks(20, 1),
            ];

            let outcome = run_calpoker_container_with_action_list(&mut allocator, &moves)
                .expect("should finish");

            let (p1_balance, p2_balance) =
                get_balances_from_outcome(&outcome).expect("should work");
            assert_eq!(p2_balance, p1_balance + 200);

            assert_event_sequence(
                &outcome.local_uis[0].events,
                &[
                    game_accepted(),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                        ChannelState::Unrolling,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                        ChannelState::ResolvedUnrolled,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::WeTimedOut),
                ],
                "after_start p0",
            );
            assert_event_sequence(
                &outcome.local_uis[1].events,
                &[
                    game_proposed(),
                    game_accepted(),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                        ChannelState::Unrolling,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                        ChannelState::ResolvedUnrolled,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::OpponentTimedOut),
                ],
                "after_start p1",
            );
        },
    ));

    res.push((
        "sim_test_with_peer_container_piss_off_peer_after_accept_complete",
        &|| {
            let mut allocator = AllocEncoder::new();

            let mut moves = vec![
                GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
                GameAction::AcceptProposal(1, GameID(1)),
            ];
            moves.extend(prefix_test_moves(&mut allocator, GameID(1)));
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

            assert_event_sequence(
                &outcome.local_uis[0].events,
                &[
                    game_accepted(),
                    ExpectedEvent::OpponentMoved {
                        mover_share: Amount::new(0),
                    },
                    ExpectedEvent::OpponentMoved {
                        mover_share: Amount::new(0),
                    },
                    ExpectedEvent::Notification(ExpectedNotification::OpponentTimedOut),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                        ChannelState::Unrolling,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                        ChannelState::ResolvedUnrolled,
                    )),
                ],
                "after_accept p0",
            );
            assert_event_sequence(
                &outcome.local_uis[1].events,
                &[
                    game_proposed(),
                    game_accepted(),
                    ExpectedEvent::OpponentMoved {
                        mover_share: Amount::new(0),
                    },
                    ExpectedEvent::GameMessage,
                    ExpectedEvent::OpponentMoved {
                        mover_share: Amount::new(0),
                    },
                    ExpectedEvent::OpponentMoved {
                        mover_share: Amount::new(200),
                    },
                    ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                        ChannelState::Unrolling,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::WeTimedOut),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                        ChannelState::ResolvedUnrolled,
                    )),
                ],
                "after_accept p1",
            );
        },
    ));

    res.push((
        "sim_test_with_peer_container_piss_off_peer_timeout",
        &|| {
            let mut allocator = AllocEncoder::new();

            let mut moves = vec![
                GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
                GameAction::AcceptProposal(1, GameID(1)),
            ];
            moves.extend(prefix_test_moves(&mut allocator, GameID(1)));
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

            assert_event_sequence(
                &outcome.local_uis[0].events,
                &[
                    game_accepted(),
                    ExpectedEvent::OpponentMoved {
                        mover_share: Amount::new(0),
                    },
                    ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                        ChannelState::Unrolling,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                        ChannelState::ResolvedUnrolled,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::OpponentTimedOut),
                ],
                "timeout p0",
            );
            assert_event_sequence(
                &outcome.local_uis[1].events,
                &[
                    game_proposed(),
                    game_accepted(),
                    ExpectedEvent::OpponentMoved {
                        mover_share: Amount::new(0),
                    },
                    ExpectedEvent::GameMessage,
                    ExpectedEvent::OpponentMoved {
                        mover_share: Amount::new(0),
                    },
                    ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                        ChannelState::Unrolling,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                        ChannelState::ResolvedUnrolled,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::WeTimedOut),
                ],
                "timeout p1",
            );
        },
    ));

    res.push(("sim_test_with_peer_container_piss_off_peer_slash", &|| {
        let mut allocator = AllocEncoder::new();

        // Play 3 moves off-chain (not all 5, so the game still has
        // moves remaining), then go on-chain. Alice replays Move 3
        // via redo; once that lands it becomes Bob's turn for Move 4.
        // Cheat(1) defers until Bob is on-chain and it's his turn,
        // then submits a move with invalid data that Alice detects.
        let mut moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
        ];
        moves.extend(prefix_test_moves(&mut allocator, GameID(1)));
        moves.truncate(5);
        moves.push(GameAction::GoOnChain(0));
        moves.push(GameAction::Cheat(1, GameID(1), Amount::default()));
        // Let both players process blocks so Alice detects & slashes.
        moves.push(GameAction::WaitBlocks(30, 0));

        let outcome =
            run_calpoker_container_with_action_list(&mut allocator, &moves).expect("should finish");

        let (p1_balance, p2_balance) = get_balances_from_outcome(&outcome).expect("should work");
        // Alice (player 0) should get all the money via slash because
        // Bob (player 1) cheated.
        assert_eq!(p1_balance, p2_balance + 200);

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::OpponentPlayedIllegalMove),
                ExpectedEvent::Notification(ExpectedNotification::WeSlashedOpponent),
            ],
            "piss_off_slash p0",
        );
        assert_event_sequence(
            &outcome.local_uis[1].events,
            &[
                game_proposed(),
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::GameMessage,
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::WeMoved),
                ExpectedEvent::Notification(ExpectedNotification::OpponentSlashedUs),
            ],
            "piss_off_slash p1",
        );
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
        let outcome = run_game_container_with_action_list_with_success_predicate(
            &mut allocator,
            &mut rng,
            sim_setup.private_keys.clone(),
            &sim_setup.identities,
            b"debug",
            &sim_setup.args_program.clone(),
            &sim_setup.game_actions,
            None,
            None,
        )
        .expect("should finish");

        let (p1_balance, p2_balance) = get_balances_from_outcome(&outcome).expect("should work");
        // Bob was slashable so alice gets the money.
        assert_eq!(p1_balance, p2_balance + 200);

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::OpponentPlayedIllegalMove),
                ExpectedEvent::Notification(ExpectedNotification::WeSlashedOpponent),
            ],
            "alice_slash p0",
        );
        assert_event_sequence(
            &outcome.local_uis[1].events,
            &[
                game_proposed(),
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(50),
                },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::WeMoved),
                ExpectedEvent::Notification(ExpectedNotification::OpponentSlashedUs),
            ],
            "alice_slash p1",
        );
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
            None,
        )
        .expect("should finish");

        let (p1_balance, p2_balance) = get_balances_from_outcome(&outcome).expect("should work");
        // Alice was slashable so bob gets the money.
        assert_eq!(p1_balance + 200, p2_balance);

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(150),
                },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::WeMoved),
                ExpectedEvent::Notification(ExpectedNotification::OpponentSlashedUs),
            ],
            "bob_slash p0",
        );
        assert_event_sequence(
            &outcome.local_uis[1].events,
            &[
                game_proposed(),
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(50),
                },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::OpponentPlayedIllegalMove),
                ExpectedEvent::Notification(ExpectedNotification::WeSlashedOpponent),
            ],
            "bob_slash p1",
        );
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
        add_debug_test_accept_shutdown(&mut sim_setup, 20, 1);
        let outcome = run_game_container_with_action_list_with_success_predicate(
            &mut allocator,
            &mut rng,
            sim_setup.private_keys.clone(),
            &sim_setup.identities,
            b"debug",
            &sim_setup.args_program.clone(),
            &sim_setup.game_actions,
            None,
            None,
        )
        .expect("should finish");

        let (p1_balance, p2_balance) = get_balances_from_outcome(&outcome).expect("should work");
        // Alice assigned bob 49, so alice is greater.
        let amount_diff = 151 - 49;
        assert_eq!(p1_balance, p2_balance + amount_diff);

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(150),
                },
                ExpectedEvent::Notification(ExpectedNotification::OpponentTimedOut),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ShuttingDown,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedClean,
                )),
            ],
            "debug_alice p0",
        );
        assert_event_sequence(
            &outcome.local_uis[1].events,
            &[
                game_proposed(),
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(50),
                },
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(49),
                },
                ExpectedEvent::Notification(ExpectedNotification::WeTimedOut),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ShuttingDown,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedClean,
                )),
            ],
            "debug_alice p1",
        );
        assert!(
            outcome.local_uis[0].clean_shutdown_complete,
            "p0 should reach ResolvedClean"
        );
        assert!(
            outcome.local_uis[1].clean_shutdown_complete,
            "p1 should reach ResolvedClean"
        );
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
        add_debug_test_accept_shutdown(&mut sim_setup, 20, 0);
        let outcome = run_game_container_with_action_list_with_success_predicate(
            &mut allocator,
            &mut rng,
            sim_setup.private_keys.clone(),
            &sim_setup.identities,
            b"debug",
            &sim_setup.args_program.clone(),
            &sim_setup.game_actions,
            None,
            None,
        )
        .expect("should finish");

        let (p1_balance, p2_balance) = get_balances_from_outcome(&outcome).expect("should work");
        // Alice assigned bob 49, so alice is greater.
        let amount_diff = 151 - 49;
        assert_eq!(p1_balance + amount_diff, p2_balance);

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(150),
                },
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(49),
                },
                ExpectedEvent::Notification(ExpectedNotification::WeTimedOut),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ShuttingDown,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedClean,
                )),
            ],
            "debug_bob p0",
        );
        assert_event_sequence(
            &outcome.local_uis[1].events,
            &[
                game_proposed(),
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(50),
                },
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(49),
                },
                ExpectedEvent::Notification(ExpectedNotification::OpponentTimedOut),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ShuttingDown,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedClean,
                )),
            ],
            "debug_bob p1",
        );
        assert!(
            outcome.local_uis[0].clean_shutdown_complete,
            "p0 should reach ResolvedClean"
        );
        assert!(
            outcome.local_uis[1].clean_shutdown_complete,
            "p1 should reach ResolvedClean"
        );
    }));

    res.push(("test_debug_game_out_of_money", &|| {
        let mut allocator = AllocEncoder::new();
        let seed_data: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed_data);
        let moves = [DebugGameTestMove::new(150, 0)];

        let mut sim_setup = setup_debug_test(&mut allocator, &mut rng, &moves).expect("ok");
        add_debug_test_accept_shutdown(&mut sim_setup, 20, 1);
        let game_type: &[u8] = b"debug";

        let mut outcome = run_game_container_with_action_list_with_success_predicate(
            &mut allocator,
            &mut rng,
            sim_setup.private_keys.clone(),
            &sim_setup.identities,
            game_type,
            &sim_setup.args_program,
            &sim_setup.game_actions,
            Some(&|_, cradles| cradles[0].handshake_finished() && cradles[1].handshake_finished()),
            None,
        )
        .expect("should finish");

        let borrowed: &Program = sim_setup.args_program.borrow();
        let result1 = outcome.cradles[0].propose_game(
            &mut allocator,
            &GameStart {
                amount: Amount::new(2000),
                my_contribution: Amount::new(1000),
                game_type: GameType(game_type.to_vec()),
                timeout: Timeout::new(10),
                my_turn: true,
                parameters: borrowed.clone(),
            },
        );

        assert!(result1.is_ok());

        let result2 = outcome.cradles[1].propose_game(
            &mut allocator,
            &GameStart {
                amount: Amount::new(2000),
                my_contribution: Amount::new(1000),
                game_type: GameType(game_type.to_vec()),
                timeout: Timeout::new(10),
                my_turn: true,
                parameters: borrowed.clone(),
            },
        );

        for _i in 0..100 {
            for c in 0..2 {
                let result = outcome.cradles[c].drain_all(&mut allocator).unwrap();
                for event in result.events.iter() {
                    match event {
                        CradleEvent::OutboundMessage(msg) => {
                            outcome.cradles[c ^ 1].deliver_message(msg).unwrap();
                        }
                        CradleEvent::Notification(n) => {
                            outcome.local_uis[c].notification(n).unwrap();
                        }
                        _ => {}
                    }
                }
            }
        }

        assert!(result2.is_ok());
    }));

    res.push(("test_calpoker_shutdown_nerf_alice", &|| {
        let mut allocator = AllocEncoder::new();

        let mut moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
        ];
        moves.extend(prefix_test_moves(&mut allocator, GameID(1)));
        moves.push(GameAction::NerfTransactions(0));
        moves.push(GameAction::CleanShutdown(1));

        let outcome =
            run_calpoker_container_with_action_list(&mut allocator, &moves).expect("should finish");

        let (p1_balance, p2_balance) = get_balances_from_outcome(&outcome).expect("should work");
        assert_eq!(p2_balance, p1_balance + 200);

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::OpponentTimedOut),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ShuttingDown,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedClean,
                )),
            ],
            "shutdown_nerf_alice p0",
        );
        assert_event_sequence(
            &outcome.local_uis[1].events,
            &[
                game_proposed(),
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::GameMessage,
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(200),
                },
                ExpectedEvent::Notification(ExpectedNotification::WeTimedOut),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ShuttingDown,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedClean,
                )),
            ],
            "shutdown_nerf_alice p1",
        );
        assert!(
            outcome.local_uis[0].clean_shutdown_complete,
            "p0 should reach ResolvedClean"
        );
        assert!(
            outcome.local_uis[1].clean_shutdown_complete,
            "p1 should reach ResolvedClean"
        );
    }));

    res.push(("test_calpoker_shutdown_nerf_bob", &|| {
        let mut allocator = AllocEncoder::new();

        let mut moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
        ];
        moves.extend(prefix_test_moves(&mut allocator, GameID(1)));
        moves.push(GameAction::NerfTransactions(1));
        moves.push(GameAction::CleanShutdown(1));

        let outcome =
            run_calpoker_container_with_action_list(&mut allocator, &moves).expect("should finish");

        let (p1_balance, p2_balance) = get_balances_from_outcome(&outcome).expect("should work");
        assert_eq!(p2_balance, p1_balance + 200);

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::OpponentTimedOut),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ShuttingDown,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedClean,
                )),
            ],
            "shutdown_nerf_bob p0",
        );
        assert_event_sequence(
            &outcome.local_uis[1].events,
            &[
                game_proposed(),
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::GameMessage,
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(200),
                },
                ExpectedEvent::Notification(ExpectedNotification::WeTimedOut),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ShuttingDown,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedClean,
                )),
            ],
            "shutdown_nerf_bob p1",
        );
        assert!(
            outcome.local_uis[0].clean_shutdown_complete,
            "p0 should reach ResolvedClean"
        );
        assert!(
            outcome.local_uis[1].clean_shutdown_complete,
            "p1 should reach ResolvedClean"
        );
    }));

    res.push(("test_clean_shutdown_opponent_unrolls", &|| {
        let mut allocator = AllocEncoder::new();

        let mut moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
        ];
        moves.extend(prefix_test_moves(&mut allocator, GameID(1)));
        // Nerf both so the clean shutdown tx is dropped for both sides.
        moves.push(GameAction::NerfTransactions(0));
        moves.push(GameAction::NerfTransactions(1));
        moves.push(GameAction::CleanShutdown(1));
        // Let messages and nerfed txs fully drain before un-nerfing.
        moves.push(GameAction::WaitBlocks(3, 0));
        // Un-nerf both so the force-unroll tx and subsequent spends land.
        moves.push(GameAction::UnNerfTransactions(false));
        // Alice force-submits the unroll (simulating a malicious peer).
        moves.push(GameAction::ForceUnroll(0));
        // Wait for the unroll timeout to elapse and reward coins to be created.
        moves.push(GameAction::WaitBlocks(20, 0));

        let outcome =
            run_calpoker_container_with_action_list(&mut allocator, &moves).expect("should finish");

        let (p1_balance, p2_balance) = get_balances_from_outcome(&outcome).expect("should work");
        assert_eq!(p2_balance, p1_balance + 200);

        let p0_notifs = &outcome.local_uis[0].notifications;
        let p1_notifs = &outcome.local_uis[1].notifications;
        assert!(
            p1_notifs.iter().any(|n| matches!(
                n,
                GameNotification::ChannelStatus {
                    state: ChannelState::Unrolling,
                    ..
                }
            )),
            "player 1 should see Unrolling channel status, got: {p1_notifs:?}"
        );
        assert!(
            p1_notifs.iter().any(|n| matches!(
                n,
                GameNotification::ChannelStatus {
                    state: ChannelState::Unrolling,
                    ..
                }
            )),
            "player 1 should see Unrolling channel status, got: {p1_notifs:?}"
        );
        assert!(
            p0_notifs.iter().any(|n| matches!(
                n,
                GameNotification::ChannelStatus {
                    state: ChannelState::Unrolling,
                    ..
                }
            )),
            "player 0 should see Unrolling channel status, got: {p0_notifs:?}"
        );
    }));

    res.push(("test_clean_shutdown_unroll_before_response", &|| {
        let mut allocator = AllocEncoder::new();

        let mut moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
        ];
        moves.extend(prefix_test_moves(&mut allocator, GameID(1)));
        // Nerf all transactions so no clean shutdown tx lands.
        moves.push(GameAction::NerfTransactions(0));
        moves.push(GameAction::NerfTransactions(1));
        // Nerf player 0's messages so CleanShutdownComplete never reaches
        // the initiator (player 1).  Player 1 is in the "started the
        // attempt but hasn't gotten the response" state.
        moves.push(GameAction::NerfMessages(0));
        moves.push(GameAction::CleanShutdown(1));
        // Drain nerfed txs/msgs.
        moves.push(GameAction::WaitBlocks(3, 0));
        // Un-nerf everything so the force-unroll tx and subsequent spends land.
        moves.push(GameAction::UnNerfTransactions(false));
        moves.push(GameAction::UnNerfMessages);
        // Alice force-submits the unroll.
        moves.push(GameAction::ForceUnroll(0));
        // Wait for the unroll timeout to elapse.
        moves.push(GameAction::WaitBlocks(20, 0));

        let outcome =
            run_calpoker_container_with_action_list(&mut allocator, &moves).expect("should finish");

        let (p1_balance, p2_balance) = get_balances_from_outcome(&outcome).expect("should work");
        assert_eq!(p2_balance, p1_balance + 200);

        let p0_notifs = &outcome.local_uis[0].notifications;
        let p1_notifs = &outcome.local_uis[1].notifications;
        assert!(
            p1_notifs.iter().any(|n| matches!(
                n,
                GameNotification::ChannelStatus {
                    state: ChannelState::Unrolling,
                    ..
                }
            )),
            "player 1 should see Unrolling channel status, got: {p1_notifs:?}"
        );
        assert!(
            p1_notifs.iter().any(|n| matches!(
                n,
                GameNotification::ChannelStatus {
                    state: ChannelState::Unrolling,
                    ..
                }
            )),
            "player 1 should see Unrolling channel status, got: {p1_notifs:?}"
        );
        assert!(
            p0_notifs.iter().any(|n| matches!(
                n,
                GameNotification::ChannelStatus {
                    state: ChannelState::Unrolling,
                    ..
                }
            )),
            "player 0 should see Unrolling channel status, got: {p0_notifs:?}"
        );
    }));

    res.push(("test_notification_we_timed_out_during_redo", &|| {
        let mut allocator = AllocEncoder::new();

        // Play alice commit and bob seed normally.  Nerf Alice's messages
        // before the reveal so the reveal potato never reaches Bob.
        // hs.spend stays at pre-reveal (post-seed) state.  Alice's reveal
        // is cached for redo.  The unroll is NOT stale from Bob's view.
        let mut moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
        ];
        let game_moves = prefix_test_moves(&mut allocator, GameID(1));
        moves.push(game_moves[0].clone()); // alice commit
        moves.push(game_moves[1].clone()); // bob seed
        moves.push(GameAction::NerfMessages(0));
        moves.push(game_moves[2].clone()); // alice reveal — potato dropped

        // Go on chain; hs.spend is pre-reveal.
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
        // Wait long enough for the game coin timeout (10 blocks) to fire.
        // Alice's redo was dropped so the game coin stays at "alice's turn".
        moves.push(GameAction::WaitBlocks(110, 0));
        moves.push(GameAction::UnNerfTransactions(false));
        moves.push(GameAction::WaitBlocks(5, 0));

        let outcome =
            run_calpoker_container_with_action_list(&mut allocator, &moves).expect("should finish");

        let p0_notifs = &outcome.local_uis[0].notifications;
        let p1_notifs = &outcome.local_uis[1].notifications;
        assert_reward_coin_consistency(p0_notifs, "redo_timeout p0");
        assert_reward_coin_consistency(p1_notifs, "redo_timeout p1");
        assert!(
            p0_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::WeTimedOut { .. })),
            "player 0 should get WeTimedOut (redo move couldn't land), got: {p0_notifs:?}"
        );
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::OpponentTimedOut { .. })),
            "player 1 should get OpponentTimedOut, got: {p1_notifs:?}"
        );

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::WeTimedOut),
            ],
            "redo_timeout p0",
        );
        assert_event_sequence(
            &outcome.local_uis[1].events,
            &[
                game_proposed(),
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::OpponentTimedOut),
            ],
            "redo_timeout p1",
        );
    }));

    res.push((
        "test_notification_bob_redo_then_alice_timeout",
        &|| {
            let mut allocator = AllocEncoder::new();

            // 3 calpoker moves normally (commit, seed, reveal), then nerf
            // Bob's messages before his discard so Alice never receives it.
            // Bob's discard is cached for redo.  The unroll is NOT stale from
            // Alice's view (she never got the discard).  Bob redoes move 3
            // on-chain.  After the redo it's alice's turn (move 4).  Alice
            // is nerfed so she can't play and times out.
            let mut moves = vec![
                GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
                GameAction::AcceptProposal(1, GameID(1)),
            ];
            let game_moves = prefix_test_moves(&mut allocator, GameID(1));
            moves.push(game_moves[0].clone()); // alice commit
            moves.push(game_moves[1].clone()); // bob seed
            moves.push(game_moves[2].clone()); // alice reveal
            moves.push(GameAction::NerfMessages(1));
            moves.push(game_moves[3].clone()); // bob discard — potato dropped
            moves.push(GameAction::GoOnChain(1));
            // Nerf alice so she can't respond on-chain after bob's redo.
            moves.push(GameAction::NerfTransactions(0));
            // Wait for unroll timeout + bob's redo.
            moves.push(GameAction::WaitBlocks(4, 0));
            // Wait for game coin timeout (alice can't move).
            moves.push(GameAction::WaitBlocks(110, 0));
            // Replay alice's nerfed backlog so her timeout tx lands (bob's reward
            // is zero so he skips the transaction).
            moves.push(GameAction::UnNerfTransactions(true));
            moves.push(GameAction::WaitBlocks(5, 0));

            let outcome = run_calpoker_container_with_action_list(&mut allocator, &moves)
                .expect("should finish");

            let p0_notifs = &outcome.local_uis[0].notifications;
            let p1_notifs = &outcome.local_uis[1].notifications;
            assert_reward_coin_consistency(p0_notifs, "bob_redo_alice_timeout p0");
            assert_reward_coin_consistency(p1_notifs, "bob_redo_alice_timeout p1");
            assert!(
                p0_notifs.iter().any(|n| matches!(n, GameNotification::WeTimedOut { .. })),
                "player 0 (alice) should get WeTimedOut (nerfed, couldn't play move 4), got: {p0_notifs:?}"
            );
            assert!(
                p1_notifs.iter().any(|n| matches!(n, GameNotification::OpponentTimedOut { .. })),
                "player 1 (bob) should get OpponentTimedOut (claimed timeout), got: {p1_notifs:?}"
            );

            assert_event_sequence(&outcome.local_uis[0].events, &[
                game_accepted(),
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::ResolvedUnrolled)),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::Notification(ExpectedNotification::WeTimedOut),
            ], "bob_redo_alice_timeout p0");
            assert_event_sequence(&outcome.local_uis[1].events, &[
                game_proposed(), game_accepted(),
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::GameMessage,
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::ResolvedUnrolled)),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::WeMoved),
                ExpectedEvent::Notification(ExpectedNotification::OpponentTimedOut),
            ], "bob_redo_alice_timeout p1");
        },
    ));

    res.push(("test_notification_we_timed_out_our_turn", &|| {
        let mut allocator = AllocEncoder::new();

        // 3 calpoker moves (alice commit, bob seed, alice reveal).
        // Bob received alice's reveal so his cached_last_action is
        // cleared.  Bob goes on-chain: no redo needed.  The game
        // coin lands at bob's turn (to discard) and he never moves,
        // so his clock runs out.
        let mut moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
        ];
        moves.extend(prefix_test_moves(&mut allocator, GameID(1)));
        moves.truncate(5);
        moves.push(GameAction::GoOnChain(1));
        // 120 blocks covers the unroll timeout (5) and
        // game coin timeout (10).
        moves.push(GameAction::WaitBlocks(120, 0));

        let outcome =
            run_calpoker_container_with_action_list(&mut allocator, &moves).expect("should finish");

        let p0_notifs = &outcome.local_uis[0].notifications;
        let p1_notifs = &outcome.local_uis[1].notifications;
        assert_reward_coin_consistency(p0_notifs, "our_turn_timeout p0");
        assert_reward_coin_consistency(p1_notifs, "our_turn_timeout p1");
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::WeTimedOut { .. })),
            "player 1 should get WeTimedOut (it was our turn, no move queued), got: {p1_notifs:?}"
        );
        assert!(
            p0_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::OpponentTimedOut { .. })),
            "player 0 should get OpponentTimedOut, got: {p0_notifs:?}"
        );

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::OpponentTimedOut),
            ],
            "our_turn_timeout p0",
        );
        assert_event_sequence(
            &outcome.local_uis[1].events,
            &[
                game_proposed(),
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::GameMessage,
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::WeTimedOut),
            ],
            "our_turn_timeout p1",
        );
    }));

    res.push(("test_notification_slash_opponent_illegal_move", &|| {
        let mut allocator = AllocEncoder::new();

        // 3 moves so that after the redo (alice's reveal) it's Bob's
        // turn, allowing Cheat(1) to fire.
        let mut on_chain_moves: Vec<GameAction> = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
        ];
        let game_moves = prefix_test_moves(&mut allocator, GameID(1));
        on_chain_moves.extend(game_moves.into_iter().take(3));
        on_chain_moves.push(GameAction::GoOnChain(0));
        on_chain_moves.push(GameAction::Cheat(1, GameID(1), Amount::default()));
        on_chain_moves.push(GameAction::WaitBlocks(30, 0));

        let outcome = run_calpoker_container_with_action_list(&mut allocator, &on_chain_moves)
            .expect("should finish");

        let p0_notifs = &outcome.local_uis[0].notifications;
        assert_reward_coin_consistency(p0_notifs, "slash_illegal p0");
        assert!(
            p0_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::OpponentPlayedIllegalMove { .. })),
            "player 0 should get OpponentPlayedIllegalMove, got: {p0_notifs:?}"
        );
        assert!(
            p0_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::WeSlashedOpponent { .. })),
            "player 0 should get WeSlashedOpponent, got: {p0_notifs:?}"
        );

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::OpponentPlayedIllegalMove),
                ExpectedEvent::Notification(ExpectedNotification::WeSlashedOpponent),
            ],
            "slash_illegal p0",
        );
        assert_event_sequence(
            &outcome.local_uis[1].events,
            &[
                game_proposed(),
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::GameMessage,
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::WeMoved),
                ExpectedEvent::Notification(ExpectedNotification::OpponentSlashedUs),
            ],
            "slash_illegal p1",
        );
    }));

    res.push(("test_notification_opponent_slashed_us", &|| {
        let mut allocator = AllocEncoder::new();

        // 4 moves so that after the redo (bob's discard) it's Alice's
        // turn, allowing Cheat(0) to fire.
        let mut on_chain_moves: Vec<GameAction> = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
        ];
        let game_moves = prefix_test_moves(&mut allocator, GameID(1));
        on_chain_moves.extend(game_moves.into_iter().take(4));
        on_chain_moves.push(GameAction::GoOnChain(0));
        on_chain_moves.push(GameAction::Cheat(0, GameID(1), Amount::default()));
        on_chain_moves.push(GameAction::WaitBlocks(30, 0));

        let outcome = run_calpoker_container_with_action_list(&mut allocator, &on_chain_moves)
            .expect("should finish");

        let p0_notifs = &outcome.local_uis[0].notifications;
        let p1_notifs = &outcome.local_uis[1].notifications;
        assert_reward_coin_consistency(p1_notifs, "opponent_slashed p1");
        assert!(
            p0_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::OpponentSlashedUs { .. })),
            "player 0 (cheater) should get OpponentSlashedUs, got: {p0_notifs:?}"
        );

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::WeMoved),
                ExpectedEvent::Notification(ExpectedNotification::OpponentSlashedUs),
            ],
            "opponent_slashed p0",
        );
        assert_event_sequence(
            &outcome.local_uis[1].events,
            &[
                game_proposed(),
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::GameMessage,
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::WeMoved),
                ExpectedEvent::Notification(ExpectedNotification::OpponentPlayedIllegalMove),
                ExpectedEvent::Notification(ExpectedNotification::WeSlashedOpponent),
            ],
            "opponent_slashed p1",
        );
    }));

    res.push(("test_cheat_with_funny_mover_share", &|| {
        let mut allocator = AllocEncoder::new();

        // Play 3 moves off-chain, go on-chain. After redo it's Bob's turn.
        // Bob cheats with mover_share=137 (a distinctive value that no
        // legitimate game state would produce). Alice should detect the
        // illegal move and slash, getting the full pot. The funny share
        // lets us confirm the cheat mechanism actually uses our value
        // rather than a hardcoded default.
        let mut moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
        ];
        moves.extend(prefix_test_moves(&mut allocator, GameID(1)));
        let mut on_chain_moves: Vec<GameAction> = moves.into_iter().take(5).collect();
        on_chain_moves.push(GameAction::GoOnChain(0));
        on_chain_moves.push(GameAction::Cheat(1, GameID(1), Amount::new(137)));
        on_chain_moves.push(GameAction::WaitBlocks(30, 0));

        let outcome = run_calpoker_container_with_action_list(&mut allocator, &on_chain_moves)
            .expect("should finish");

        let (p0_balance, p1_balance) = get_balances_from_outcome(&outcome).expect("should work");
        // Alice (player 0) should get the full pot via slash.
        // Bob cheated so Alice gets all 200.
        assert_eq!(
            p0_balance,
            p1_balance + 200,
            "alice should win the full pot via slash: p0={p0_balance} p1={p1_balance}"
        );

        let p0_notifs = &outcome.local_uis[0].notifications;
        assert_reward_coin_consistency(p0_notifs, "funny_share p0");
        assert!(
            p0_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::OpponentPlayedIllegalMove { .. })),
            "player 0 should get OpponentPlayedIllegalMove, got: {p0_notifs:?}"
        );
        assert!(
            p0_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::WeSlashedOpponent { .. })),
            "player 0 should get WeSlashedOpponent, got: {p0_notifs:?}"
        );

        let p1_notifs = &outcome.local_uis[1].notifications;
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::OpponentSlashedUs { .. })),
            "player 1 (cheater) should get OpponentSlashedUs, got: {p1_notifs:?}"
        );

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::OpponentPlayedIllegalMove),
                ExpectedEvent::Notification(ExpectedNotification::WeSlashedOpponent),
            ],
            "funny_share p0",
        );
        assert_event_sequence(
            &outcome.local_uis[1].events,
            &[
                game_proposed(),
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::GameMessage,
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::WeMoved),
                ExpectedEvent::Notification(ExpectedNotification::OpponentSlashedUs),
            ],
            "funny_share p1",
        );
    }));

    res.push((
        "test_cheat_with_funny_mover_share_alice_nerfed",
        &|| {
            let mut allocator = AllocEncoder::new();

            // Same setup as test_cheat_with_funny_mover_share but Alice is
            // nerfed so she can't submit the slash transaction. Bob's cheat
            // with mover_share=137 succeeds because Alice's slash times out.
            //
            // The on-chain referee resolves using the cheat's mover_share=137,
            // giving Bob 137 of the 200 pot and Alice 63. But Alice is nerfed
            // during the critical window and can't sweep her 63-mojo coin, so
            // the balance difference is exactly 200-137 = 63 (not the full 200).
            // This proves the funny mover_share flows all the way through to
            // the on-chain resolution.
            let mut moves = vec![
                GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
                GameAction::AcceptProposal(1, GameID(1)),
            ];
            moves.extend(prefix_test_moves(&mut allocator, GameID(1)));
            let mut on_chain_moves: Vec<GameAction> = moves.into_iter().take(5).collect();
            on_chain_moves.push(GameAction::GoOnChain(0));
            on_chain_moves.push(GameAction::NerfTransactions(0));
            on_chain_moves.push(GameAction::Cheat(1, GameID(1), Amount::new(137)));
            on_chain_moves.push(GameAction::WaitBlocks(120, 0));
            on_chain_moves.push(GameAction::UnNerfTransactions(false));
            on_chain_moves.push(GameAction::WaitBlocks(30, 0));

            let outcome = run_calpoker_container_with_action_list(&mut allocator, &on_chain_moves)
                .expect("should finish");

            let (p0_balance, p1_balance) =
                get_balances_from_outcome(&outcome).expect("should work");
            // After Bob cheats with mover_share=137, the keys swap so Alice
            // becomes the MOVER of the new coin. MOVER_SHARE goes to Alice
            // (137) and Bob (the WAITER) gets 63. Net: Alice +37, Bob -37.
            assert_eq!(
                (p0_balance as i64) - (p1_balance as i64), 74,
                "balance difference should reflect funny mover_share: \
                 Alice gets 137, Bob gets 63: p0={p0_balance} p1={p1_balance}"
            );

            let p0_notifs = &outcome.local_uis[0].notifications;
            let p1_notifs = &outcome.local_uis[1].notifications;
            assert_reward_coin_consistency(p0_notifs, "nerfed_cheat p0");
            assert_reward_coin_consistency(p1_notifs, "nerfed_cheat p1");
            assert!(
                p0_notifs.iter().any(|n| matches!(n, GameNotification::OpponentPlayedIllegalMove { .. })),
                "player 0 should get OpponentPlayedIllegalMove, got: {p0_notifs:?}"
            );
            assert!(
                p0_notifs.iter().any(|n| matches!(n, GameNotification::OpponentSuccessfullyCheated { reward_coin: Some(_), .. })),
                "player 0 should get OpponentSuccessfullyCheated with reward_coin (mover_share=137), got: {p0_notifs:?}"
            );

            assert_event_sequence(&outcome.local_uis[0].events, &[
                game_accepted(),
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::ResolvedUnrolled)),
                ExpectedEvent::Notification(ExpectedNotification::OpponentPlayedIllegalMove),
                ExpectedEvent::Notification(ExpectedNotification::OpponentSuccessfullyCheated),
            ], "nerfed_cheat p0");
            assert_event_sequence(&outcome.local_uis[1].events, &[
                game_proposed(), game_accepted(),
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::GameMessage,
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::ResolvedUnrolled)),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::WeMoved),
                ExpectedEvent::Notification(ExpectedNotification::OpponentTimedOut),
            ], "nerfed_cheat p1");
        },
    ));

    res.push(("test_notification_accept_finished", &|| {
        let mut allocator = AllocEncoder::new();

        // Use 4 moves (remove only alice_accept) so the game is mid-play.
        // After redo of bob's discard it's player 0's turn, so Accept(0)
        // fires.  Go on-chain first so Accept goes through the on-chain
        // handler (off-chain Accept immediately finishes the game).
        let mut moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
        ];
        moves.extend(prefix_test_moves(&mut allocator, GameID(1)));
        moves.pop();
        moves.push(GameAction::GoOnChain(0));
        moves.push(GameAction::AcceptTimeout(0, GameID(1)));
        moves.push(GameAction::WaitBlocks(120, 1));
        moves.push(GameAction::WaitBlocks(5, 0));

        let outcome =
            run_calpoker_container_with_action_list(&mut allocator, &moves).expect("should finish");

        let p0_notifs = &outcome.local_uis[0].notifications;
        let p1_notifs = &outcome.local_uis[1].notifications;
        assert_reward_coin_consistency(p0_notifs, "accept_finished p0");
        assert_reward_coin_consistency(p1_notifs, "accept_finished p1");
        assert!(
            p0_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::WeTimedOut { .. })),
            "player 0 (who accepted) should get WeTimedOut, got: {p0_notifs:?}"
        );

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::WeTimedOut),
            ],
            "accept_finished p0",
        );
        assert_event_sequence(
            &outcome.local_uis[1].events,
            &[
                game_proposed(),
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::GameMessage,
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::WeMoved),
                ExpectedEvent::Notification(ExpectedNotification::OpponentTimedOut),
            ],
            "accept_finished p1",
        );
    }));

    res.push(("test_accept_timeout_nerfed_then_on_chain", &|| {
        let mut allocator = AllocEncoder::new();

        // Bob accepts off-chain (it's his turn after calpoker) but his
        // potato is nerfed so Alice never receives it.  Then Bob goes
        // on-chain.  The unroll resolves to the pre-accept state (Alice
        // never countersigned the accept batch).  Bob should still get
        // WeTimedOut through the on-chain timeout path, which finds the
        // game in pending_accept_timeouts.
        let mut moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
        ];
        moves.extend(prefix_test_moves(&mut allocator, GameID(1)));
        moves.push(GameAction::NerfMessages(1));
        moves.push(GameAction::GoOnChain(1));
        moves.push(GameAction::WaitBlocks(120, 0));
        moves.push(GameAction::WaitBlocks(5, 1));

        let outcome =
            run_calpoker_container_with_action_list(&mut allocator, &moves).expect("should finish");

        let p1_notifs = &outcome.local_uis[1].notifications;
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::WeTimedOut { .. })),
            "player 1 should get WeTimedOut after nerfed accept + on-chain, got: {p1_notifs:?}"
        );
    }));

    res.push(("test_accept_after_nerfed_peer_gets_share", &|| {
        let mut allocator = AllocEncoder::new();
        let seed_data: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed_data);

        // Single debug-game move: Alice sets mover_share to 100 (half of the
        // 200-unit pot).  Alice then gets nerfed so her transactions are
        // dropped, goes on-chain (disconnecting from Bob), and Bob accepts the
        // result and goes on-chain himself.  Bob's unroll lands and after the
        // timeout both players receive their rewards (the referee timeout
        // creates coins for both mover and waiter in one transaction).
        let moves = [DebugGameTestMove::new(100, 0)];
        let mut sim_setup =
            setup_debug_test(&mut allocator, &mut rng, &moves).expect("ok");
        sim_setup.game_actions.push(GameAction::NerfTransactions(0));
        sim_setup.game_actions.push(GameAction::GoOnChain(0));
        sim_setup.game_actions.push(GameAction::AcceptTimeout(1, GameID(1)));
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
            None,
        )
        .expect("should finish");

        let p0_notifs = &outcome.local_uis[0].notifications;
        let p1_notifs = &outcome.local_uis[1].notifications;
        assert_reward_coin_consistency(p0_notifs, "nerfed_accept p0");
        assert_reward_coin_consistency(p1_notifs, "nerfed_accept p1");
        assert!(
            p1_notifs.iter().any(|n| matches!(n, GameNotification::WeTimedOut { reward_coin: Some(_), .. })),
            "Bob (who accepted) should get WeTimedOut with a non-null reward_coin, got: {p1_notifs:?}"
        );

        let (p0_balance, p1_balance) =
            get_balances_from_outcome(&outcome).expect("should get balances");
        // The referee timeout transaction (submitted by Bob) creates reward
        // coins for both players.  Even though Alice is nerfed, her reward
        // coin is created on-chain by Bob's timeout spend.
        assert_eq!(
            p0_balance, p1_balance,
            "Both players get their 100 from the referee timeout (p0={p0_balance} p1={p1_balance})"
        );

        assert_event_sequence(&outcome.local_uis[0].events, &[
            game_accepted(),
            ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::Unrolling)),
            ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
            ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::ResolvedUnrolled)),
            ExpectedEvent::Notification(ExpectedNotification::OpponentTimedOut),
        ], "nerfed_accept p0");
        assert_event_sequence(&outcome.local_uis[1].events, &[
            game_proposed(), game_accepted(),
            ExpectedEvent::OpponentMoved { mover_share: Amount::new(100) },
            ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::Unrolling)),
            ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
            ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::ResolvedUnrolled)),
            ExpectedEvent::Notification(ExpectedNotification::WeTimedOut),
        ], "nerfed_accept p1");
    }));

    res.push(("test_game_cancellation_nerfed_proposal", &|| {
        let mut allocator = AllocEncoder::new();

        // Set up game A (calpoker, 100+100) first.
        // Channel is funded with 200 per player (400 total) so there is
        // 100 per player left over for game B.
        //
        // Sequence:
        //  1. ProposeNewGame(0) — Alice queues game B (50+50).  She may
        //     not have the potato yet so it gets queued.
        //  2. GoOnChain(1) — Bob goes on-chain.  peer_disconnected stops
        //     all of Bob's messages (outbound dropped by the sim loop,
        //     inbound dropped by deliver_message).  Bob's unroll tx goes
        //     through with game A only (hs.spend reflects the last potato
        //     Bob received, which predates game B).
        //  3. Alice detects the channel coin spend.  Game B is in
        //     pre_game_ids but not surviving_ids → GameCancelled.
        let moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::GoOnChain(1),
            GameAction::WaitBlocks(120, 0),
            GameAction::WaitBlocks(5, 0),
        ];

        let outcome = run_calpoker_container_with_action_list_with_success_predicate(
            &mut allocator,
            &moves,
            None,
            Some(200),
        )
        .expect("should finish");

        let p0_notifs = &outcome.local_uis[0].notifications;
        assert!(
            p0_notifs.iter().any(|n| matches!(n, GameNotification::GameProposalCancelled { .. })),
            "Alice should get GameProposalCancelled for her proposed game, got: {p0_notifs:?}"
        );

        assert_event_sequence(&outcome.local_uis[0].events[..5], &[
            game_accepted(),
            ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::Unrolling)),
            ExpectedEvent::Notification(ExpectedNotification::GameProposalCancelled),
            ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
            ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::ResolvedUnrolled)),
        ], "cancellation_nerfed p0 prefix");
        let p0_tail: Vec<String> = outcome.local_uis[0].events[5..].iter().map(event_shape).collect();
        let p0_terminal: Vec<&str> = p0_tail.iter().filter(|s| {
            s.starts_with("Notif(WeTimedOut)") || s.starts_with("Notif(OpponentTimedOut)")
        }).map(|s| s.as_str()).collect();
        assert_eq!(p0_terminal.len(), 1,
            "cancellation_nerfed p0 should have exactly 1 terminal notification, got {:?}. All events: {:?}",
            p0_terminal, outcome.local_uis[0].events);

        // p1 also sees game B proposed+cancelled because Alice's proposal
        // arrives before Bob goes on-chain.
        let p1_prefix = &outcome.local_uis[1].events[..7];
        assert_event_sequence(p1_prefix, &[
            game_proposed(), game_accepted(),
            ExpectedEvent::Notification(ExpectedNotification::GameProposed),
            ExpectedEvent::Notification(ExpectedNotification::GameProposalCancelled),
            ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::Unrolling)),
            ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
            ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::ResolvedUnrolled)),
        ], "cancellation_nerfed p1 prefix");
        let p1_tail: Vec<String> = outcome.local_uis[1].events[7..].iter().map(event_shape).collect();
        let p1_terminal: Vec<&str> = p1_tail.iter().filter(|s| {
            s.starts_with("Notif(WeTimedOut)") || s.starts_with("Notif(OpponentTimedOut)")
        }).map(|s| s.as_str()).collect();
        assert_eq!(p1_terminal.len(), 1,
            "cancellation_nerfed p1 should have exactly 1 terminal notification, got {:?}. All events: {:?}",
            p1_terminal, outcome.local_uis[1].events);
    }));

    res.push(("test_on_chain_before_any_moves_times_out", &|| {
        let mut allocator = AllocEncoder::new();

        // Create game A during test setup, then go on-chain before any
        // moves. The game coin should time out normally on-chain.
        // GameCancelled only happens when a game was proposed but never
        // committed (unroll reverts to before the game existed).
        let moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
            GameAction::GoOnChain(1),
            GameAction::WaitBlocks(20, 1),
        ];

        let outcome =
            run_calpoker_container_with_action_list(&mut allocator, &moves).expect("should finish");

        let p0_notifs = &outcome.local_uis[0].notifications;
        let p1_notifs = &outcome.local_uis[1].notifications;
        assert_reward_coin_consistency(p0_notifs, "before_any_moves p0");
        assert_reward_coin_consistency(p1_notifs, "before_any_moves p1");
        assert!(
            p0_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::WeTimedOut { .. })),
            "player 0 should get WeTimedOut (it was their turn, no move made), got: {p0_notifs:?}"
        );
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::OpponentTimedOut { .. })),
            "player 1 should get OpponentTimedOut (claimed timeout), got: {p1_notifs:?}"
        );

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::WeTimedOut),
            ],
            "before_any_moves p0",
        );
        assert_event_sequence(
            &outcome.local_uis[1].events,
            &[
                game_proposed(),
                game_accepted(),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::OpponentTimedOut),
            ],
            "before_any_moves p1",
        );
    }));

    res.push((
        "test_notification_opponent_successfully_cheated",
        &|| {
            let mut allocator = AllocEncoder::new();

            // 3 moves so that after the redo (alice's reveal) it's Bob's
            // turn, allowing Cheat(1) to fire.
            let mut moves = vec![
                GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
                GameAction::AcceptProposal(1, GameID(1)),
            ];
            moves.extend(prefix_test_moves(&mut allocator, GameID(1)));
            let mut on_chain_moves: Vec<GameAction> = moves.into_iter().take(5).collect();
            on_chain_moves.push(GameAction::GoOnChain(0));
            on_chain_moves.push(GameAction::NerfTransactions(0));
            on_chain_moves.push(GameAction::Cheat(1, GameID(1), Amount::default()));
            on_chain_moves.push(GameAction::WaitBlocks(120, 0));
            on_chain_moves.push(GameAction::UnNerfTransactions(false));
            on_chain_moves.push(GameAction::WaitBlocks(30, 0));

            let outcome = run_calpoker_container_with_action_list(&mut allocator, &on_chain_moves)
                .expect("should finish");

            let p0_notifs = &outcome.local_uis[0].notifications;
            let p1_notifs = &outcome.local_uis[1].notifications;
            assert_reward_coin_consistency(p0_notifs, "opp_cheated p0");
            assert_reward_coin_consistency(p1_notifs, "opp_cheated p1");
            assert!(
                p0_notifs.iter().any(|n| matches!(n, GameNotification::OpponentPlayedIllegalMove { .. })),
                "player 0 should get OpponentPlayedIllegalMove, got: {p0_notifs:?}"
            );
            assert!(
                p0_notifs.iter().any(|n| matches!(n, GameNotification::OpponentSuccessfullyCheated { reward_coin: None, .. })),
                "player 0 should get OpponentSuccessfullyCheated with no reward (cheat mover_share=0), got: {p0_notifs:?}"
            );

            assert_event_sequence(&outcome.local_uis[0].events, &[
                game_accepted(),
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::ResolvedUnrolled)),
                ExpectedEvent::Notification(ExpectedNotification::OpponentPlayedIllegalMove),
                ExpectedEvent::Notification(ExpectedNotification::OpponentSuccessfullyCheated),
            ], "opp_cheated p0");
            assert_event_sequence(&outcome.local_uis[1].events, &[
                game_proposed(), game_accepted(),
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::GameMessage,
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::ResolvedUnrolled)),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::WeMoved),
                ExpectedEvent::Notification(ExpectedNotification::OpponentTimedOut),
            ], "opp_cheated p1");
        },
    ));

    res.push((
        "test_notification_game_destroyed_on_chain",
        &|| {
            let mut allocator = AllocEncoder::new();

            // 3 moves so after redo it's Bob's turn; destroying the coin
            // from Alice's view gives a GameError or ChannelError.
            let mut moves = vec![
                GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
                GameAction::AcceptProposal(1, GameID(1)),
            ];
            moves.extend(prefix_test_moves(&mut allocator, GameID(1)));
            let mut on_chain_moves: Vec<GameAction> = moves.into_iter().take(5).collect();
            on_chain_moves.push(GameAction::GoOnChain(0));
            on_chain_moves.push(GameAction::ForceDestroyCoin(0, GameID(1)));
            on_chain_moves.push(GameAction::WaitBlocks(30, 0));

            let outcome = run_calpoker_container_with_action_list(&mut allocator, &on_chain_moves)
                .expect("should finish");

            let p0_notifs = &outcome.local_uis[0].notifications;
            assert!(
                p0_notifs.iter().any(|n| matches!(n, GameNotification::GameError { .. }))
                || p0_notifs.iter().any(|n| matches!(n, GameNotification::ChannelStatus { state: ChannelState::Failed, .. })),
                "player 0 should get GameError or ChannelError when coin is force-destroyed, got: {p0_notifs:?}"
            );

            assert_event_sequence(&outcome.local_uis[0].events, &[
                game_accepted(),
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::ResolvedUnrolled)),
                ExpectedEvent::Notification(ExpectedNotification::GameError),
            ], "destroyed p0");
            assert_event_sequence(&outcome.local_uis[1].events, &[
                game_proposed(), game_accepted(),
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::GameMessage,
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::ResolvedUnrolled)),
                ExpectedEvent::Notification(ExpectedNotification::GameError),
            ], "destroyed p1");
        },
    ));

    res.push((
        "test_post_handshake_alice_nerfed_bob_unrolls",
        &|| {
            let mut allocator = AllocEncoder::new();
            let seed_data: [u8; 32] = [0; 32];
            let mut rng = ChaCha8Rng::from_seed(seed_data);
            let pk1: PrivateKey = rng.gen();
            let id1 = ChiaIdentity::new(&mut allocator, pk1).expect("ok");
            let pk2: PrivateKey = rng.gen();
            let id2 = ChiaIdentity::new(&mut allocator, pk2).expect("ok");
            let private_keys: [ChannelHandlerPrivateKeys; 2] = rng.gen();
            let identities: [ChiaIdentity; 2] = [id1, id2];

            // WaitBlocks at the start lets the post-handshake empty potato
            // exchange complete so hs.spend is properly set before go_on_chain.
            // Alice is nerfed during go_on_chain so her outbound txs are
            // dropped.  Un-nerf before WaitBlocks so she can sweep her
            // reward coin once the unroll completes.
            let moves = vec![
                GameAction::WaitBlocks(5, 0),
                GameAction::NerfTransactions(0),
                GameAction::GoOnChain(1),
                GameAction::UnNerfTransactions(false),
                GameAction::WaitBlocks(120, 0),
            ];

            let outcome = run_game_container_with_action_list_with_success_predicate(
                &mut allocator,
                &mut rng,
                private_keys,
                &identities,
                b"calpoker",
                &Program::from_hex("80").unwrap(),
                &moves,
                None,
                None,
            )
            .expect("should finish");

            let (p0_balance, p1_balance) =
                get_balances_from_outcome(&outcome).expect("should work");
            assert_eq!(
                p0_balance, p1_balance,
                "both players should get exactly the same amount back (no game was played): p0={p0_balance} p1={p1_balance}"
            );

            assert_event_sequence(&outcome.local_uis[0].events, &[
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::ResolvedUnrolled)),
            ], "alice_nerfed p0");
            assert_event_sequence(&outcome.local_uis[1].events, &[
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::ResolvedUnrolled)),
            ], "alice_nerfed p1");
        },
    ));

    res.push((
        "test_post_handshake_bob_nerfed_alice_unrolls",
        &|| {
            let mut allocator = AllocEncoder::new();
            let seed_data: [u8; 32] = [0; 32];
            let mut rng = ChaCha8Rng::from_seed(seed_data);
            let pk1: PrivateKey = rng.gen();
            let id1 = ChiaIdentity::new(&mut allocator, pk1).expect("ok");
            let pk2: PrivateKey = rng.gen();
            let id2 = ChiaIdentity::new(&mut allocator, pk2).expect("ok");
            let private_keys: [ChannelHandlerPrivateKeys; 2] = rng.gen();
            let identities: [ChiaIdentity; 2] = [id1, id2];

            let moves = vec![
                GameAction::WaitBlocks(5, 0),
                GameAction::NerfTransactions(1),
                GameAction::GoOnChain(0),
                GameAction::UnNerfTransactions(false),
                GameAction::WaitBlocks(120, 0),
            ];

            let outcome = run_game_container_with_action_list_with_success_predicate(
                &mut allocator,
                &mut rng,
                private_keys,
                &identities,
                b"calpoker",
                &Program::from_hex("80").unwrap(),
                &moves,
                None,
                None,
            )
            .expect("should finish");

            let (p0_balance, p1_balance) =
                get_balances_from_outcome(&outcome).expect("should work");
            assert_eq!(
                p0_balance, p1_balance,
                "both players should get exactly the same amount back (no game was played): p0={p0_balance} p1={p1_balance}"
            );

            assert_event_sequence(&outcome.local_uis[0].events, &[
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::ResolvedUnrolled)),
            ], "bob_nerfed p0");
            assert_event_sequence(&outcome.local_uis[1].events, &[
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::ResolvedUnrolled)),
            ], "bob_nerfed p1");
        },
    ));

    res.push(("test_notification_opponent_made_impossible_spend", &|| {
        let mut allocator = AllocEncoder::new();

        let mut moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
        ];
        moves.extend(prefix_test_moves(&mut allocator, GameID(1)));
        let mut on_chain_moves: Vec<GameAction> = moves.into_iter().take(4).collect();
        on_chain_moves.push(GameAction::GoOnChain(0));
        on_chain_moves.push(GameAction::WaitBlocks(5, 0));
        on_chain_moves.push(GameAction::ForceDestroyCoin(1, GameID(1)));
        on_chain_moves.push(GameAction::WaitBlocks(30, 0));

        let outcome = run_calpoker_container_with_action_list(&mut allocator, &on_chain_moves)
            .expect("should finish");

        let all_notifs: Vec<&GameNotification> = outcome
            .local_uis
            .iter()
            .flat_map(|ui| ui.notifications.iter())
            .collect();
        assert!(
            all_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::GameError { .. })),
            "some player should get GameError when game coin force-destroyed, got: {all_notifs:?}"
        );

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::GameError),
            ],
            "impossible_spend p0",
        );
        assert_event_sequence(
            &outcome.local_uis[1].events,
            &[
                game_proposed(),
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::WeMoved),
                ExpectedEvent::Notification(ExpectedNotification::GameError),
            ],
            "impossible_spend p1",
        );
    }));

    res.push((
        "test_notification_our_turn_coin_spent_unexpectedly",
        &|| {
            let mut allocator = AllocEncoder::new();

            let mut moves = vec![
                GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
                GameAction::AcceptProposal(1, GameID(1)),
            ];
            moves.extend(prefix_test_moves(&mut allocator, GameID(1)));
            let mut on_chain_moves: Vec<GameAction> = moves.into_iter().take(4).collect();
            on_chain_moves.push(GameAction::GoOnChain(0));
            on_chain_moves.push(GameAction::WaitBlocks(5, 0));
            on_chain_moves.push(GameAction::ForceDestroyCoin(0, GameID(1)));
            on_chain_moves.push(GameAction::WaitBlocks(30, 0));

            let outcome = run_calpoker_container_with_action_list(&mut allocator, &on_chain_moves)
                .expect("should finish");

            let all_notifs: Vec<&GameNotification> = outcome.local_uis.iter()
                .flat_map(|ui| ui.notifications.iter())
                .collect();
            assert!(
                all_notifs.iter().any(|n| matches!(n, GameNotification::GameError { .. })),
                "some player should get GameError when own game coin force-destroyed, got: {all_notifs:?}"
            );

            assert_event_sequence(&outcome.local_uis[0].events, &[
                game_accepted(),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::ResolvedUnrolled)),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::Notification(ExpectedNotification::GameError),
            ], "our_turn_spent p0");
            assert_event_sequence(&outcome.local_uis[1].events, &[
                game_proposed(), game_accepted(),
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(ChannelState::ResolvedUnrolled)),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::WeMoved),
                ExpectedEvent::Notification(ExpectedNotification::GameError),
            ], "our_turn_spent p1");
        },
    ));

    res.push(("test_unroll_state_too_high", &|| {
        let mut allocator = AllocEncoder::new();

        let moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
            // Let the handshake + empty potato exchanges settle.
            GameAction::WaitBlocks(5, 0),
            // Corrupt player 1: pretend we're at state 0.
            // This wipes stored unroll/timeout so the real on-chain
            // state number will be "from the future" AND unmatchable.
            GameAction::CorruptStateNumber(1, 0),
            // Player 0 goes on chain normally (real state number).
            GameAction::GoOnChain(0),
            GameAction::WaitBlocks(20, 0),
        ];

        let outcome = run_calpoker_container_with_action_list_with_success_predicate(
            &mut allocator,
            &moves,
            Some(&|_, cradles| {
                cradles[0].is_on_chain() && (cradles[1].is_on_chain() || cradles[1].is_failed())
            }),
            None,
        )
        .expect("should finish");

        assert!(
            outcome.cradles[1].is_failed(),
            "player 1 should be in Failed state"
        );
        let p1_notifs = &outcome.local_uis[1].notifications;
        assert!(
            p1_notifs.iter().any(|n| matches!(
                n,
                GameNotification::ChannelStatus {
                    state: ChannelState::Failed,
                    ..
                }
            )),
            "player 1 should get ChannelError for state-from-the-future, got: {p1_notifs:?}"
        );
        let channel_error_idx = p1_notifs
            .iter()
            .position(|n| {
                matches!(
                    n,
                    GameNotification::ChannelStatus {
                        state: ChannelState::Failed,
                        ..
                    }
                )
            })
            .unwrap();
        for n in &p1_notifs[channel_error_idx + 1..] {
            panic!("no notifications should arrive after ChannelError, but got {n:?}");
        }

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
            ],
            "state_too_high p0",
        );
        assert_event_sequence(
            &outcome.local_uis[1].events,
            &[
                game_proposed(),
                game_accepted(),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameError),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Failed,
                )),
            ],
            "state_too_high p1",
        );
    }));

    res.push(("test_unroll_wrong_parity_old_state", &|| {
        let mut allocator = AllocEncoder::new();

        let moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
            // Let the handshake + empty potato exchanges settle.
            GameAction::WaitBlocks(5, 0),
            // Corrupt player 1: pretend we're at state 100.
            // The real on-chain state (~3) will look "old" from player 1's
            // perspective.  With stored unroll/timeout wiped, neither
            // preemption (no matching parity+sig) nor timeout (no stored
            // state) can succeed.
            GameAction::CorruptStateNumber(1, 100),
            // Player 0 goes on chain normally.
            GameAction::GoOnChain(0),
            GameAction::WaitBlocks(20, 0),
        ];

        let outcome = run_calpoker_container_with_action_list_with_success_predicate(
            &mut allocator,
            &moves,
            Some(&|_, cradles| {
                cradles[0].is_on_chain() && (cradles[1].is_on_chain() || cradles[1].is_failed())
            }),
            None,
        )
        .expect("should finish");

        assert!(
            outcome.cradles[1].is_failed(),
            "player 1 should be in Failed state"
        );
        let p1_notifs = &outcome.local_uis[1].notifications;
        assert!(
            p1_notifs.iter().any(|n| matches!(
                n,
                GameNotification::ChannelStatus {
                    state: ChannelState::Failed,
                    ..
                }
            )),
            "player 1 should get ChannelError for wrong-parity old state, got: {p1_notifs:?}"
        );
        let channel_error_idx = p1_notifs
            .iter()
            .position(|n| {
                matches!(
                    n,
                    GameNotification::ChannelStatus {
                        state: ChannelState::Failed,
                        ..
                    }
                )
            })
            .unwrap();
        for n in &p1_notifs[channel_error_idx + 1..] {
            panic!("no notifications should arrive after ChannelError, but got {n:?}");
        }

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
            ],
            "wrong_parity p0",
        );
        assert_event_sequence(
            &outcome.local_uis[1].events,
            &[
                game_proposed(),
                game_accepted(),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameError),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Failed,
                )),
            ],
            "wrong_parity p1",
        );
    }));

    res.push(("test_go_on_chain_then_move_queued_and_replayed", &|| {
        let mut allocator = AllocEncoder::new();

        // Nerf Alice's messages so her commit potato never reaches Bob.
        // Alice's local state advances (commit cached for redo) but
        // hs.spend stays pre-commit because Bob never acknowledged.
        // GoOnChainThenMove broadcasts the pre-commit unroll and queues
        // the reveal.  The unroll is NOT stale from Bob's perspective
        // (he never got the commit).  Alice redoes her commit on-chain,
        // then it's Bob's turn for the seed.  Bob is nerfed so he
        // times out.  The queued reveal never fires (game ends first).
        let mut all_moves_vec = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
        ];
        all_moves_vec.extend(prefix_test_moves(&mut allocator, GameID(1)));
        let all_moves = all_moves_vec;
        let mut moves = Vec::new();
        moves.push(GameAction::WaitBlocks(5, 0));
        moves.push(all_moves[0].clone()); // propose game
        moves.push(all_moves[1].clone()); // accept proposal
        moves.push(GameAction::NerfMessages(0));
        moves.push(all_moves[2].clone()); // alice commit — potato dropped
        moves.push(GameAction::GoOnChainThenMove(0));
        moves.push(all_moves[4].clone()); // alice reveal — consumed by GoOnChainThenMove
        moves.push(GameAction::NerfTransactions(1));
        moves.push(GameAction::WaitBlocks(120, 0));

        let outcome = run_calpoker_container_with_action_list_with_success_predicate(
            &mut allocator,
            &moves,
            None,
            None,
        )
        .expect("should finish");

        for (i, notifs) in outcome.local_uis.iter().enumerate() {
            for n in &notifs.notifications {
                assert!(
                    !matches!(
                        n,
                        GameNotification::ChannelStatus {
                            state: ChannelState::Failed,
                            ..
                        }
                    ),
                    "player {i} should not get ChannelError, got: {n:?}"
                );
            }
        }

        let p0_notifs = &outcome.local_uis[0].notifications;
        let p1_notifs = &outcome.local_uis[1].notifications;
        assert_reward_coin_consistency(p0_notifs, "go_on_chain_then_move p0");
        assert_reward_coin_consistency(p1_notifs, "go_on_chain_then_move p1");
        assert!(
            p0_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::OpponentTimedOut { .. })),
            "alice should get OpponentTimedOut (bob was nerfed), got: {p0_notifs:?}"
        );
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::WeTimedOut { .. })),
            "bob should get WeTimedOut (nerfed, couldn't play), got: {p1_notifs:?}"
        );

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::WeMoved),
                ExpectedEvent::Notification(ExpectedNotification::OpponentTimedOut),
            ],
            "go_on_chain_then_move p0",
        );
        assert_event_sequence(
            &outcome.local_uis[1].events,
            &[
                game_proposed(),
                game_accepted(),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::Notification(ExpectedNotification::ChannelState(
                    ChannelState::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameOnChain),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::WeTimedOut),
            ],
            "go_on_chain_then_move p1",
        );
    }));

    // ──────────────────────────────────────────────────────────────────
    // Proposal lifecycle tests
    // ──────────────────────────────────────────────────────────────────

    res.push(("test_proposal_cancel_by_receiver", &|| {
        let mut allocator = AllocEncoder::new();

        // No initial game — just proposals. Alice proposes (50+50),
        // Bob has the potato and cancels. After cancel, Alice has the
        // potato and initiates clean shutdown (no live games to block it).
        let moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::CancelProposal(1, GameID(1)),
            GameAction::CleanShutdown(0),
        ];

        let outcome = run_calpoker_container_with_action_list_with_success_predicate(
            &mut allocator,
            &moves,
            None,
            Some(200),
        )
        .expect("should finish");

        let p0_notifs = &outcome.local_uis[0].notifications;
        assert!(
            p0_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::GameProposalCancelled { .. })),
            "Alice should see GameProposalCancelled, got: {p0_notifs:?}"
        );

        let p1_notifs = &outcome.local_uis[1].notifications;
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::GameProposed { .. })),
            "Bob should see GameProposed, got: {p1_notifs:?}"
        );
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::GameProposalCancelled { .. })),
            "Bob should see GameProposalCancelled, got: {p1_notifs:?}"
        );
    }));

    res.push(("test_proposal_accept_then_on_chain", &|| {
        let mut allocator = AllocEncoder::new();

        // No initial game. Alice proposes (50+50), Bob accepts. A
        // WaitBlocks gap lets Alice process Bob's accept before going
        // on-chain. Both sides should see GameProposed + GameProposalAccepted.
        let moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
            GameAction::WaitBlocks(1, 2),
            GameAction::GoOnChain(0),
            GameAction::WaitBlocks(120, 0),
            GameAction::WaitBlocks(5, 0),
        ];

        let outcome = run_calpoker_container_with_action_list_with_success_predicate(
            &mut allocator,
            &moves,
            None,
            Some(200),
        )
        .expect("should finish");

        let p0_notifs = &outcome.local_uis[0].notifications;
        assert!(
            p0_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::GameProposalAccepted { .. })),
            "Alice should see GameProposalAccepted, got: {p0_notifs:?}"
        );

        let p1_notifs = &outcome.local_uis[1].notifications;
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::GameProposed { .. })),
            "Bob should see GameProposed, got: {p1_notifs:?}"
        );
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::GameProposalAccepted { .. })),
            "Bob should see GameProposalAccepted, got: {p1_notifs:?}"
        );
    }));

    res.push(("test_proposal_clean_shutdown_cancels_proposals", &|| {
        let mut allocator = AllocEncoder::new();

        // No initial game. Alice proposes, Bob has the potato and
        // initiates clean shutdown. The proposal should be cancelled
        // on both sides.
        let moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::CleanShutdown(1),
        ];

        let outcome = run_calpoker_container_with_action_list_with_success_predicate(
            &mut allocator,
            &moves,
            None,
            Some(200),
        )
        .expect("should finish");

        let p0_notifs = &outcome.local_uis[0].notifications;
        assert!(
            p0_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::GameProposalCancelled { .. })),
            "Alice should see GameProposalCancelled during shutdown, got: {p0_notifs:?}"
        );

        let p1_notifs = &outcome.local_uis[1].notifications;
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::GameProposed { .. })),
            "Bob should see GameProposed, got: {p1_notifs:?}"
        );
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::GameProposalCancelled { .. })),
            "Bob should see GameProposalCancelled during shutdown, got: {p1_notifs:?}"
        );
    }));

    res.push(("test_proposal_cancel_by_proposer", &|| {
        let mut allocator = AllocEncoder::new();

        // Alice proposes, then Alice cancels her own proposal.
        // After proposal the potato is with Bob; CancelProposal(0)
        // queues the cancel and requests the potato back.
        let moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::CancelProposal(0, GameID(1)),
            GameAction::CleanShutdown(0),
        ];

        let outcome = run_calpoker_container_with_action_list_with_success_predicate(
            &mut allocator,
            &moves,
            None,
            Some(200),
        )
        .expect("should finish");

        let p0_notifs = &outcome.local_uis[0].notifications;
        assert!(
            p0_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::GameProposalCancelled { .. })),
            "Alice should see GameProposalCancelled, got: {p0_notifs:?}"
        );

        let p1_notifs = &outcome.local_uis[1].notifications;
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::GameProposed { .. })),
            "Bob should see GameProposed, got: {p1_notifs:?}"
        );
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::GameProposalCancelled { .. })),
            "Bob should see GameProposalCancelled, got: {p1_notifs:?}"
        );
    }));

    res.push(("test_insufficient_balance_on_accept", &|| {
        let mut allocator = AllocEncoder::new();

        // Initial game A (100+100) consumes all balance (per_player_balance=100).
        // Alice proposes game B (50+50). Bob tries to accept but has
        // insufficient balance. After InsufficientBalance, go on-chain
        // to resolve game A and cancel the pending proposal.
        let moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(3)),
            GameAction::GoOnChain(0),
            GameAction::WaitBlocks(120, 0),
            GameAction::WaitBlocks(5, 0),
        ];

        let outcome = run_calpoker_container_with_action_list_with_success_predicate(
            &mut allocator,
            &moves,
            None,
            Some(100),
        )
        .expect("should finish");

        let p1_notifs = &outcome.local_uis[1].notifications;
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::InsufficientBalance { .. })),
            "Bob should get InsufficientBalance, got: {p1_notifs:?}"
        );
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::GameProposalCancelled { .. })),
            "Bob should get GameProposalCancelled after InsufficientBalance, got: {p1_notifs:?}"
        );
    }));

    res.push(("test_stale_cancel_after_accept", &|| {
        let mut allocator = AllocEncoder::new();

        // No initial game. Alice proposes (50+50), Bob accepts. Alice
        // queues a cancel for the same game, but Bob's accept has already
        // been processed by the time Alice gets the potato. The cancel
        // should be silently discarded. The game resolves on-chain.
        let moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
            GameAction::CancelProposal(0, GameID(1)),
            GameAction::GoOnChain(0),
            GameAction::WaitBlocks(120, 0),
            GameAction::WaitBlocks(5, 0),
        ];

        let outcome = run_calpoker_container_with_action_list_with_success_predicate(
            &mut allocator,
            &moves,
            None,
            Some(200),
        )
        .expect("should finish without crashing on stale cancel");

        let p0_notifs = &outcome.local_uis[0].notifications;
        assert!(
            p0_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::GameProposalAccepted { .. })),
            "Alice should see GameProposalAccepted (accept wins the race), got: {p0_notifs:?}"
        );
    }));

    res.push(("test_stale_unroll_game_at_current_state", &|| {
        let mut allocator = AllocEncoder::new();
        let seed_data: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed_data);

        let moves = [DebugGameTestMove::new(100, 0)];
        let mut sim_setup =
            setup_debug_test(&mut allocator, &mut rng, &moves).expect("ok");

        sim_setup.game_actions.push(GameAction::SaveUnrollSnapshot(1));
        // Proposal round-trip advances player 0's state_number past
        // the snapshot without changing the first game's referee PH.
        sim_setup.game_actions.push(GameAction::ProposeNewGame(0, ProposeTrigger::Channel));
        sim_setup.game_actions.push(GameAction::AcceptProposal(1, GameID(3)));
        sim_setup.game_actions.push(GameAction::WaitBlocks(5, 0));
        // Nerf both players to prevent preemption during channel coin
        // spend detection.  After un-nerfing, only the timeout path fires.
        sim_setup.game_actions.push(GameAction::NerfTransactions(0));
        sim_setup.game_actions.push(GameAction::NerfTransactions(1));
        sim_setup.game_actions.push(GameAction::ForceStaleUnroll(1));
        sim_setup.game_actions.push(GameAction::WaitBlocks(2, 2));
        sim_setup.game_actions.push(GameAction::UnNerfTransactions(false));
        sim_setup.game_actions.push(GameAction::WaitBlocks(120, 2));
        sim_setup.game_actions.push(GameAction::WaitBlocks(5, 0));

        let outcome = run_game_container_with_action_list_with_success_predicate(
            &mut allocator,
            &mut rng,
            sim_setup.private_keys.clone(),
            &sim_setup.identities,
            b"debug",
            &sim_setup.args_program,
            &sim_setup.game_actions,
            Some(&|_, cradles| {
                cradles[0].is_on_chain() || cradles[0].is_failed()
            }),
            Some(200),
        )
        .expect("should finish");

        assert!(
            !outcome.cradles[0].is_failed(),
            "player 0 should NOT be in Failed state"
        );

        let p0_notifs = &outcome.local_uis[0].notifications;
        assert!(
            p0_notifs.iter().any(|n| matches!(n, GameNotification::ChannelStatus { state: ChannelState::ResolvedStale, .. })),
            "player 0 should see ResolvedStale, got: {p0_notifs:?}"
        );
        // The accept round-tripped, so the second game is fully live (not a
        // pending accept). It's absent from the stale unroll → GameError.
        let game_errors: Vec<_> = p0_notifs.iter().filter(|n| matches!(n, GameNotification::GameError { .. })).collect();
        assert!(
            game_errors.len() == 1,
            "player 0 should get exactly one GameError for the fully-live second game, got: {game_errors:?}, all: {p0_notifs:?}"
        );
        assert!(
            !p0_notifs.iter().any(|n| matches!(n, GameNotification::ChannelStatus { state: ChannelState::Failed, .. })),
            "player 0 should NOT get ChannelError, got: {p0_notifs:?}"
        );
    }));

    res.push(("test_stale_unroll_game_at_redo_state", &|| {
        let mut allocator = AllocEncoder::new();
        let seed_data: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed_data);

        let moves = [
            DebugGameTestMove::new(100, 0),
            DebugGameTestMove::new(50, 0),
            DebugGameTestMove::new(75, 0),
        ];
        let mut sim_setup =
            setup_debug_test(&mut allocator, &mut rng, &moves).expect("ok");

        let third_move = sim_setup.game_actions.pop().unwrap();

        // Proposal sends potato from player 0 to player 1, updating player 1's
        // last_channel_coin_spend_info to reflect the state after both moves.
        sim_setup.game_actions.push(GameAction::ProposeNewGame(0, ProposeTrigger::Channel));
        sim_setup.game_actions.push(GameAction::WaitBlocks(3, 0));
        // NOW snapshot: player 1 just received the proposal potato, so their
        // cached spend info includes the correct game PH (after 2 moves).
        sim_setup.game_actions.push(GameAction::SaveUnrollSnapshot(1));
        sim_setup.game_actions.push(GameAction::AcceptProposal(1, GameID(3)));
        sim_setup.game_actions.push(GameAction::WaitBlocks(5, 0));
        // Third move with player 1's reply nerfed: player 0 sends the move,
        // player 1 receives but reply is dropped → cached_last_actions set.
        sim_setup.game_actions.push(GameAction::NerfMessages(1));
        sim_setup.game_actions.push(third_move);
        sim_setup.game_actions.push(GameAction::UnNerfMessages);
        // Nerf both to prevent preemption during channel coin spend detection.
        sim_setup.game_actions.push(GameAction::NerfTransactions(0));
        sim_setup.game_actions.push(GameAction::NerfTransactions(1));
        sim_setup.game_actions.push(GameAction::ForceStaleUnroll(1));
        sim_setup.game_actions.push(GameAction::WaitBlocks(2, 2));
        sim_setup.game_actions.push(GameAction::UnNerfTransactions(false));
        sim_setup.game_actions.push(GameAction::WaitBlocks(120, 2));
        sim_setup.game_actions.push(GameAction::WaitBlocks(5, 0));

        let outcome = run_game_container_with_action_list_with_success_predicate(
            &mut allocator,
            &mut rng,
            sim_setup.private_keys.clone(),
            &sim_setup.identities,
            b"debug",
            &sim_setup.args_program,
            &sim_setup.game_actions,
            Some(&|_, cradles| {
                cradles[0].is_on_chain() || cradles[0].is_failed()
            }),
            Some(200),
        )
        .expect("should finish");

        assert!(
            !outcome.cradles[0].is_failed(),
            "player 0 should NOT be in Failed state"
        );

        let p0_notifs = &outcome.local_uis[0].notifications;
        assert!(
            p0_notifs.iter().any(|n| matches!(n, GameNotification::ChannelStatus { state: ChannelState::ResolvedStale, .. })),
            "player 0 should see ResolvedStale, got: {p0_notifs:?}"
        );
        // The redo recovers the first game, but the second game's accept
        // round-tripped (fully live), absent from the stale unroll → GameError.
        let game_errors: Vec<_> = p0_notifs.iter().filter(|n| matches!(n, GameNotification::GameError { .. })).collect();
        assert!(
            game_errors.len() == 1,
            "player 0 should get exactly one GameError for the fully-live second game, got: {game_errors:?}, all: {p0_notifs:?}"
        );
        assert!(
            !p0_notifs.iter().any(|n| matches!(n, GameNotification::ChannelStatus { state: ChannelState::Failed, .. })),
            "player 0 should NOT get ChannelError, got: {p0_notifs:?}"
        );
    }));

    res.push(("test_stale_unroll_game_at_error_state", &|| {
        let mut allocator = AllocEncoder::new();
        let seed_data: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed_data);

        let moves = [
            DebugGameTestMove::new(100, 0),
            DebugGameTestMove::new(50, 0),
        ];
        let mut sim_setup = setup_debug_test(&mut allocator, &mut rng, &moves).expect("ok");

        let second_move = sim_setup.game_actions.pop().unwrap();
        sim_setup
            .game_actions
            .push(GameAction::SaveUnrollSnapshot(1));
        // Move 2 changes the game PH.
        sim_setup.game_actions.push(second_move);
        // Proposal round-trip advances state_number past the snapshot
        // so the stale detection triggers.
        sim_setup
            .game_actions
            .push(GameAction::ProposeNewGame(0, ProposeTrigger::Channel));
        sim_setup
            .game_actions
            .push(GameAction::AcceptProposal(1, GameID(3)));
        sim_setup.game_actions.push(GameAction::WaitBlocks(5, 0));
        // Nerf both to prevent preemption during channel coin spend detection.
        sim_setup.game_actions.push(GameAction::NerfTransactions(0));
        sim_setup.game_actions.push(GameAction::NerfTransactions(1));
        sim_setup.game_actions.push(GameAction::ForceStaleUnroll(1));
        sim_setup.game_actions.push(GameAction::WaitBlocks(2, 2));
        sim_setup
            .game_actions
            .push(GameAction::UnNerfTransactions(false));
        sim_setup.game_actions.push(GameAction::WaitBlocks(120, 2));
        sim_setup.game_actions.push(GameAction::WaitBlocks(5, 0));

        let outcome = run_game_container_with_action_list_with_success_predicate(
            &mut allocator,
            &mut rng,
            sim_setup.private_keys.clone(),
            &sim_setup.identities,
            b"debug",
            &sim_setup.args_program,
            &sim_setup.game_actions,
            Some(&|_, cradles| cradles[0].is_on_chain() || cradles[0].is_failed()),
            Some(200),
        )
        .expect("should finish");

        assert!(
            !outcome.cradles[0].is_failed(),
            "player 0 should NOT be in Failed state"
        );

        let p0_notifs = &outcome.local_uis[0].notifications;
        assert!(
            p0_notifs.iter().any(|n| matches!(
                n,
                GameNotification::ChannelStatus {
                    state: ChannelState::ResolvedStale,
                    ..
                }
            )),
            "player 0 should see ResolvedStale, got: {p0_notifs:?}"
        );
        // First game: coin present but at an old PH → GameError.
        // Second game: accept round-tripped (fully live), absent from stale unroll → GameError.
        let game_errors: Vec<_> = p0_notifs
            .iter()
            .filter(|n| matches!(n, GameNotification::GameError { .. }))
            .collect();
        assert!(
            game_errors.len() >= 1,
            "player 0 should get at least one GameError, got: {game_errors:?}, all: {p0_notifs:?}"
        );
        assert!(
            !p0_notifs.iter().any(|n| matches!(
                n,
                GameNotification::ChannelStatus {
                    state: ChannelState::Failed,
                    ..
                }
            )),
            "player 0 should NOT get ChannelError, got: {p0_notifs:?}"
        );
    }));

    res.push(("test_stale_unroll_pending_accept_cancelled", &|| {
        let mut allocator = AllocEncoder::new();
        let seed_data: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed_data);

        let moves = [DebugGameTestMove::new(100, 0)];
        let mut sim_setup =
            setup_debug_test(&mut allocator, &mut rng, &moves).expect("ok");

        sim_setup.game_actions.push(GameAction::SaveUnrollSnapshot(1));
        // Proposal round-trip advances player 0's state_number past
        // the snapshot so that the stale detection triggers.
        sim_setup.game_actions.push(GameAction::ProposeNewGame(0, ProposeTrigger::Channel));
        sim_setup.game_actions.push(GameAction::AcceptProposal(1, GameID(3)));
        sim_setup.game_actions.push(GameAction::WaitBlocks(5, 0));
        // Player 1 proposes a third game; player 0 will accept it.
        // No ID collision possible: role-namespaced nonces ensure each
        // player's game IDs use distinct parity (odd vs even).
        sim_setup.game_actions.push(GameAction::ProposeNewGame(1, ProposeTrigger::Channel));
        sim_setup.game_actions.push(GameAction::WaitBlocks(3, 0));
        // Nerf player 1's messages so the accept response never reaches
        // player 0 — the third game stays in cached_last_actions as ProposalAccepted.
        sim_setup.game_actions.push(GameAction::NerfMessages(1));
        sim_setup.game_actions.push(GameAction::AcceptProposal(0, GameID(0)));
        sim_setup.game_actions.push(GameAction::WaitBlocks(3, 0));
        sim_setup.game_actions.push(GameAction::UnNerfMessages);
        sim_setup.game_actions.push(GameAction::NerfTransactions(0));
        sim_setup.game_actions.push(GameAction::NerfTransactions(1));
        sim_setup.game_actions.push(GameAction::ForceStaleUnroll(1));
        sim_setup.game_actions.push(GameAction::WaitBlocks(2, 2));
        sim_setup.game_actions.push(GameAction::UnNerfTransactions(false));
        sim_setup.game_actions.push(GameAction::WaitBlocks(120, 2));
        sim_setup.game_actions.push(GameAction::WaitBlocks(5, 0));

        let outcome = run_game_container_with_action_list_with_success_predicate(
            &mut allocator,
            &mut rng,
            sim_setup.private_keys.clone(),
            &sim_setup.identities,
            b"debug",
            &sim_setup.args_program,
            &sim_setup.game_actions,
            Some(&|_, cradles| {
                cradles[0].is_on_chain() || cradles[0].is_failed()
            }),
            Some(300),
        )
        .expect("should finish");

        assert!(
            !outcome.cradles[0].is_failed(),
            "player 0 should NOT be in Failed state"
        );

        let p0_notifs = &outcome.local_uis[0].notifications;
        assert!(
            p0_notifs.iter().any(|n| matches!(n, GameNotification::ChannelStatus { state: ChannelState::ResolvedStale, .. })),
            "player 0 should see ResolvedStale, got: {p0_notifs:?}"
        );
        // The second game (fully live, round-tripped) is absent → GameError.
        let game_errors: Vec<_> = p0_notifs.iter().filter(|n| matches!(n, GameNotification::GameError { .. })).collect();
        assert!(
            game_errors.len() == 1,
            "player 0 should get exactly one GameError for the fully-live second game, got: {game_errors:?}, all: {p0_notifs:?}"
        );
        // The third game (in-flight proposal accept) is absent → GameCancelled.
        let game_cancels: Vec<_> = p0_notifs.iter().filter(|n| matches!(n, GameNotification::GameCancelled { .. })).collect();
        assert!(
            game_cancels.len() == 1,
            "player 0 should get exactly one GameCancelled for the in-flight accept, got: {game_cancels:?}, all: {p0_notifs:?}"
        );
        assert!(
            !p0_notifs.iter().any(|n| matches!(n, GameNotification::ChannelStatus { state: ChannelState::Failed, .. })),
            "player 0 should NOT get ChannelError, got: {p0_notifs:?}"
        );
    }));

    // ── Zero-reward early-out tests ──────────────────────────────────────

    res.push(("test_zero_reward_redo_skipped", &|| {
        let mut allocator = AllocEncoder::new();
        let seed_data: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed_data);

        // Alice makes a move with mover_share = 200 (the full pot).  After
        // the move Bob is the new mover and gets everything on timeout;
        // Alice as waiter gets 0.  Nerf Alice's messages so the potato
        // never reaches Bob — this means the unroll lands at the pre-move
        // state and a redo would be needed.  Instead of performing the redo
        // (which would give Alice 0), the system should immediately emit
        // WeTimedOut(0) for Alice.
        let moves = [DebugGameTestMove::new(200, 0)];
        let mut sim_setup = setup_debug_test(&mut allocator, &mut rng, &moves).expect("ok");

        // WaitBlocks lets the handshake and game setup complete before we
        // nerf.  NerfMessages then drops Alice's potato so Bob never sees
        // the move.
        sim_setup
            .game_actions
            .insert(0, GameAction::WaitBlocks(5, 0));
        sim_setup
            .game_actions
            .insert(3, GameAction::NerfMessages(0));
        sim_setup.game_actions.push(GameAction::GoOnChain(0));
        sim_setup.game_actions.push(GameAction::WaitBlocks(120, 1));
        sim_setup.game_actions.push(GameAction::WaitBlocks(5, 0));

        let outcome = run_game_container_with_action_list_with_success_predicate(
            &mut allocator,
            &mut rng,
            sim_setup.private_keys.clone(),
            &sim_setup.identities,
            b"debug",
            &sim_setup.args_program,
            &sim_setup.game_actions,
            None,
            None,
        )
        .expect("should finish");

        let p0_notifs = &outcome.local_uis[0].notifications;
        assert!(
            p0_notifs.iter().any(|n| matches!(
                n,
                GameNotification::WeTimedOut { our_reward, reward_coin: None, .. }
                if *our_reward == Amount::default()
            )),
            "Alice should get WeTimedOut with zero reward (redo skipped), got: {p0_notifs:?}"
        );
    }));

    res.push(("test_zero_reward_accepted_after_unroll", &|| {
        let mut allocator = AllocEncoder::new();
        let seed_data: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed_data);

        // Two moves: Alice sets mover_share=0 (Bob gets 0 as new mover),
        // Bob sets mover_share=0 (Alice gets 0 as new mover).  Now it's
        // Alice's turn and her share as mover is 0.  Let both moves be
        // acknowledged normally.  Then nerf Alice's messages and call
        // AcceptTimeout (game moves to pending_accept_timeouts but potato
        // never reaches Bob).  Go on-chain.  The coin matches via
        // pending_accept_timeouts with accepted=true.  Alice's share is 0
        // so she should get immediate WeTimedOut(0).
        let moves = [DebugGameTestMove::new(0, 0), DebugGameTestMove::new(0, 0)];
        let mut sim_setup = setup_debug_test(&mut allocator, &mut rng, &moves).expect("ok");
        sim_setup.game_actions.push(GameAction::WaitBlocks(5, 0));
        sim_setup.game_actions.push(GameAction::NerfMessages(0));
        sim_setup
            .game_actions
            .push(GameAction::AcceptTimeout(0, GameID(1)));
        sim_setup.game_actions.push(GameAction::GoOnChain(0));
        sim_setup.game_actions.push(GameAction::WaitBlocks(120, 1));
        sim_setup.game_actions.push(GameAction::WaitBlocks(5, 0));

        let outcome = run_game_container_with_action_list_with_success_predicate(
            &mut allocator,
            &mut rng,
            sim_setup.private_keys.clone(),
            &sim_setup.identities,
            b"debug",
            &sim_setup.args_program,
            &sim_setup.game_actions,
            None,
            None,
        )
        .expect("should finish");

        let p0_notifs = &outcome.local_uis[0].notifications;
        assert!(
            p0_notifs.iter().any(|n| matches!(
                n,
                GameNotification::WeTimedOut { our_reward, reward_coin: None, .. }
                if *our_reward == Amount::default()
            )),
            "Alice should get WeTimedOut with zero reward (accepted, unroll), got: {p0_notifs:?}"
        );
    }));

    res.push(("test_zero_reward_opponent_turn_after_unroll", &|| {
        let mut allocator = AllocEncoder::new();
        let seed_data: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed_data);

        // Alice makes a move with mover_share = 200 (full pot to Bob).
        // The potato comes back (move is acknowledged).  Go on-chain.
        // After unroll it's Bob's turn with mover_share = 200 — Alice as
        // waiter gets 0.  The opponent has no incentive to move.  Alice
        // should get immediate WeTimedOut(0).
        let moves = [DebugGameTestMove::new(200, 0)];
        let mut sim_setup = setup_debug_test(&mut allocator, &mut rng, &moves).expect("ok");

        // Let the move be acknowledged (no nerf), then go on-chain.
        sim_setup.game_actions.push(GameAction::GoOnChain(0));
        sim_setup.game_actions.push(GameAction::WaitBlocks(120, 1));
        sim_setup.game_actions.push(GameAction::WaitBlocks(5, 0));

        let outcome = run_game_container_with_action_list_with_success_predicate(
            &mut allocator,
            &mut rng,
            sim_setup.private_keys.clone(),
            &sim_setup.identities,
            b"debug",
            &sim_setup.args_program,
            &sim_setup.game_actions,
            None,
            None,
        )
        .expect("should finish");

        let p0_notifs = &outcome.local_uis[0].notifications;
        assert!(
            p0_notifs.iter().any(|n| matches!(
                n,
                GameNotification::WeTimedOut { our_reward, reward_coin: None, .. }
                if *our_reward == Amount::default()
            )),
            "Alice should get WeTimedOut with zero reward (opponent's turn, dead game), got: {p0_notifs:?}"
        );
    }));

    res.push(("test_zero_reward_on_chain_move_skipped", &|| {
        let mut allocator = AllocEncoder::new();
        let seed_data: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed_data);

        // Alice makes move 0 (mover_share=100), Bob makes move 1
        // (mover_share=100).  Now it's Alice's turn.  Alice's move 2
        // sets mover_share=200 (giving Bob everything).  We use
        // GoOnChainThenMove to go on-chain and immediately queue the
        // losing move.  After the unroll the on-chain handler processes
        // the move.  Instead of submitting, the system should detect
        // mover_share == coin_amount and fire WeTimedOut(0) for Alice.
        let moves = [
            DebugGameTestMove::new(100, 0),
            DebugGameTestMove::new(100, 0),
            DebugGameTestMove::new(200, 0),
        ];
        let mut sim_setup = setup_debug_test(&mut allocator, &mut rng, &moves).expect("ok");

        // Extract the third move to pair with GoOnChainThenMove.
        let on_chain_move = sim_setup.game_actions.pop().unwrap();

        sim_setup.game_actions.push(GameAction::GoOnChainThenMove(0));
        sim_setup.game_actions.push(on_chain_move);
        sim_setup.game_actions.push(GameAction::WaitBlocks(120, 1));
        sim_setup.game_actions.push(GameAction::WaitBlocks(5, 0));

        let outcome = run_game_container_with_action_list_with_success_predicate(
            &mut allocator,
            &mut rng,
            sim_setup.private_keys.clone(),
            &sim_setup.identities,
            b"debug",
            &sim_setup.args_program,
            &sim_setup.game_actions,
            None,
            None,
        )
        .expect("should finish");

        let p0_notifs = &outcome.local_uis[0].notifications;
        assert!(
            p0_notifs.iter().any(|n| matches!(
                n,
                GameNotification::WeTimedOut { our_reward, reward_coin: None, .. }
                if *our_reward == Amount::default()
            )),
            "Alice should get WeTimedOut with zero reward (on-chain move skipped), got: {p0_notifs:?}"
        );
    }));

    res.push(("test_zero_reward_on_chain_accept_timeout", &|| {
        let mut allocator = AllocEncoder::new();
        let seed_data: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed_data);

        // Alice makes move 0 (mover_share=0, giving Alice everything as
        // waiter).  Bob makes move 1 (mover_share=0, giving Bob everything
        // as waiter).  Now it's Alice's turn, her share as mover is 0.
        // Go on-chain, wait for unroll.  Alice calls AcceptTimeout on-chain.
        // Since her share is 0, the system should skip the timeout wait and
        // immediately fire WeTimedOut(0).
        let moves = [
            DebugGameTestMove::new(0, 0),
            DebugGameTestMove::new(0, 0),
        ];
        let mut sim_setup = setup_debug_test(&mut allocator, &mut rng, &moves).expect("ok");

        sim_setup.game_actions.push(GameAction::GoOnChain(0));
        sim_setup.game_actions.push(GameAction::WaitBlocks(120, 1));
        sim_setup.game_actions.push(GameAction::WaitBlocks(5, 0));
        sim_setup.game_actions.push(GameAction::AcceptTimeout(0, GameID(1)));
        sim_setup.game_actions.push(GameAction::WaitBlocks(5, 0));

        let outcome = run_game_container_with_action_list_with_success_predicate(
            &mut allocator,
            &mut rng,
            sim_setup.private_keys.clone(),
            &sim_setup.identities,
            b"debug",
            &sim_setup.args_program,
            &sim_setup.game_actions,
            None,
            None,
        )
        .expect("should finish");

        let p0_notifs = &outcome.local_uis[0].notifications;
        assert!(
            p0_notifs.iter().any(|n| matches!(
                n,
                GameNotification::WeTimedOut { our_reward, reward_coin: None, .. }
                if *our_reward == Amount::default()
            )),
            "Alice should get WeTimedOut with zero reward (on-chain AcceptTimeout), got: {p0_notifs:?}"
        );
    }));

    res
}
