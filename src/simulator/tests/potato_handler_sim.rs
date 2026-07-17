use std::borrow::Borrow;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use clvm_traits::{ClvmEncoder, ToClvm};
use clvmr::NodePtr;
use rand::prelude::*;
use rand_chacha::ChaCha8Rng;

use crate::channel_state::types::{ChannelEnv, ChannelPrivateKeys, ReadableMove};
use crate::common::constants::{CREATE_COIN, SINGLETON_LAUNCHER_HASH};
use crate::common::standard_coin::{
    sign_agg_sig_me, solution_for_conditions, standard_solution_partial, ChiaIdentity,
};
use crate::common::types::{atom_from_clvm, i64_from_atom, usize_from_atom};
use crate::common::types::{
    AllocEncoder, Amount, CoinSpend, CoinString, Error, GameID, GameType, IntoErr, PrivateKey,
    Program, PuzzleHash, Sha256tree, Spend, SpendBundle, Timeout, ToQuotedProgram,
};
use crate::game_session::{
    report_coin_changes_to_peer, CoinReportPhase, FullCoinSetAdapter, GameSession,
    GameSessionConfig, MessagePeerQueue, MessagePipe, PeerLifecyclePhase, WatchEntry, WatchReport,
};
use crate::games::poker_collection;
use crate::session_phases::effects::{
    apply_effects, CancelReason, ChannelStatus, Effect, GameNotification, GameSessionEvent,
    GameStatusKind, SettlementOutcome,
};
use crate::session_phases::handshake::CoinSpendRequest;
use crate::session_phases::start::GameStart;
use crate::session_phases::types::{
    BatchAction, BootstrapTowardWallet, PacketSender, PeerMessage, ToLocalUI, WalletSpendInterface,
};
use crate::session_phases::OffChainPhase;
use crate::transaction_manager::TransactionManager;
use crate::utils::proper_list;

use crate::simulator::Simulator;
use crate::test_support::calpoker::{calpoker_ran_all_the_moves_predicate, prefix_test_moves};
use crate::test_support::debug_game::{make_debug_games, DebugGameCurry};
use crate::test_support::game::{GameAction, ProposeTrigger};
use crate::test_support::peer::session_phases::run_move;
use crate::utils::pair_of_array_mut;

// potato handler tests with simulator.
#[derive(Default)]
struct SimulatedWalletSpend {
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
    peers: &mut [OffChainPhase; 2],
    pipes: &'a mut [SimulatedPeer; 2],
    simulator: &'a mut Simulator,
) -> Result<WatchReport, Error> {
    let current_height = simulator.get_current_height();
    let current_coins = simulator.get_all_coins()?;
    let watch_report =
        coinset_adapter.make_report_from_coin_set_update(current_height as u64, &current_coins)?;

    for who in 0..=1 {
        {
            let mut env = ChannelEnv::new(allocator).expect("should work");
            let mut reported_effects = report_coin_changes_to_peer(
                &mut env,
                &mut peers[who],
                &watch_report,
                CoinReportPhase::Created,
            )?;
            reported_effects.extend(report_coin_changes_to_peer(
                &mut env,
                &mut peers[who],
                &watch_report,
                CoinReportPhase::Spent,
            )?);
            apply_effects(reported_effects, allocator, &mut pipes[who])?;
        }
    }

    Ok(watch_report)
}

fn handle_received_channel_puzzle_hash(
    env: &mut ChannelEnv<'_>,
    identity: &ChiaIdentity,
    peer: &mut OffChainPhase,
    parent: &CoinString,
    channel_handler_puzzle_hash: &PuzzleHash,
) -> Result<Vec<Effect>, Error> {
    let ch = peer.channel_state()?;
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
    request: &crate::session_phases::handshake::CoinSpendRequest,
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

    let (_, _, coin_amount) = selected_coin
        .to_parts()
        .ok_or_else(|| Error::StrErr("selected coin missing parts".to_string()))?;

    // Build conditions that mimic a real wallet's createOfferForIds: the spend
    // is balanced because the requested amount goes to a settlement payment
    // output instead of being a deficit.  claim_settlement_coins (called in
    // GameSession::provide_coin_spend_bundle) will add claim spends
    // that consume these settlement outputs, restoring the deficit.
    let settlement_ph = PuzzleHash::from_bytes(chia_puzzles::SETTLEMENT_PAYMENT_HASH);
    let change_amount = Amount::new(coin_amount.to_u64() - request.amount.to_u64());

    let mut create_targets: Vec<(PuzzleHash, Amount)> = Vec::new();
    // Settlement output (offer-style: the "offered" mojos)
    create_targets.push((settlement_ph, request.amount.clone()));
    // Change back to wallet
    if change_amount.to_u64() > 0 {
        create_targets.push((identity.puzzle_hash.clone(), change_amount));
    }
    // Extra conditions from the request (e.g., CREATE_COIN for launcher)
    for cond in &request.conditions {
        if cond.opcode == CREATE_COIN && cond.args.len() >= 2 {
            let ph_bytes: [u8; 32] = cond.args[0]
                .as_slice()
                .try_into()
                .map_err(|_| Error::StrErr("bad puzzle hash in extra condition".to_string()))?;
            let amt = if cond.args[1].is_empty() {
                0u64
            } else {
                crate::common::types::u64_from_atom(&cond.args[1]).unwrap_or(0)
            };
            create_targets.push((PuzzleHash::from_bytes(ph_bytes), Amount::new(amt)));
        }
    }

    let env = ChannelEnv::new(allocator)?;
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
                name,
            },
        );
        Ok(())
    }
}

impl WalletSpendInterface for SimulatedPeer {
    /// Enqueue an outbound transaction.
    fn spend_transaction_and_add_fee(
        &mut self,
        bundle: &SpendBundle,
        _expiry: Option<u64>,
    ) -> Result<(), Error> {
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
        _spend: Option<SpendBundle>,
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
            GameNotification::GameStatus { other_params, .. } => {
                if let Some(params) = other_params {
                    if let Some(readable) = &params.readable {
                        if params.mover_share.is_none() {
                            self.messages.push(readable.clone());
                        }
                    }
                }
                Ok(())
            }
            GameNotification::ChannelStatus { state, .. } => {
                use crate::session_phases::effects::ChannelStatus;
                match state {
                    ChannelStatus::GoingOnChain
                    | ChannelStatus::Unrolling
                    | ChannelStatus::ResolvedUnrolled
                    | ChannelStatus::ResolvedStale
                    | ChannelStatus::Failed => Err(Error::StrErr(format!(
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
    peers: &mut [OffChainPhase; 2],
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
                let mut env = ChannelEnv::new(allocator).expect("should work");
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
                let mut env = ChannelEnv::new(allocator).expect("should work");
                peers[who].channel_transaction_completion(&mut env, &u)?
            };
            if let Some(effect) = reported_effect {
                apply_effects(vec![effect], allocator, &mut pipes[who])?;
            }

            let env = ChannelEnv::new(allocator).expect("should work");
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
            let included_result = simulator.push_transactions(env.allocator, &spends.spends)?;

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
    GameSettledOurSide,
    GameSettledOpponentSide,
    GameStatusEndedCancelled,
    GameStatusIllegalMoveDetected,
    GameSettledSlashedOpponent,
    GameSettledOpponentSlashedUs,
    GameSettledOpponentCheated,
    GameStatusMovedByUs,
    GameStatusOnChainTurn,
    GameStatusEndedError,
    ProposalMade,
    ProposalAccepted,
    ProposalCancelled,
    InsufficientBalance,
    ChannelStatus(ChannelStatus),
}

#[derive(Debug, Clone, PartialEq)]
pub enum ExpectedEvent {
    OpponentMoved { mover_share: Amount },
    GameMessage,
    Notification(ExpectedNotification),
}

fn is_terminal_game_status(status: &GameStatusKind) -> bool {
    matches!(
        status,
        GameStatusKind::EndedCancelled | GameStatusKind::EndedError
    )
}

fn has_status(n: &GameNotification, want: GameStatusKind) -> bool {
    matches!(n, GameNotification::GameStatus { status, .. } if *status == want)
}

fn has_settled_outcome(n: &GameNotification, want: SettlementOutcome) -> bool {
    matches!(
        n,
        GameNotification::GameSettled { outcome, .. } if *outcome == want
    )
}

fn is_our_side_settlement(outcome: SettlementOutcome) -> bool {
    matches!(
        outcome,
        SettlementOutcome::AcceptSettlement
            | SettlementOutcome::SettledCleanly
            | SettlementOutcome::WeAccepted
            | SettlementOutcome::ForfeitedSkippedReveal
            | SettlementOutcome::ForfeitedOpponentWon
            | SettlementOutcome::ForfeitedWeAccepted
            | SettlementOutcome::AttemptToMoveFailed
            | SettlementOutcome::TimedOutWaitingForOurMove
            | SettlementOutcome::SlashedOpponent
    )
}

fn is_opponent_side_settlement(outcome: SettlementOutcome) -> bool {
    matches!(
        outcome,
        SettlementOutcome::AcceptSettlement
            | SettlementOutcome::SettledCleanly
            | SettlementOutcome::OpponentTimedOut
            | SettlementOutcome::OpponentSlashedUs
            | SettlementOutcome::OpponentCheated
    )
}

fn is_terminal_for_id(n: &GameNotification, id: &GameID) -> bool {
    match n {
        GameNotification::InsufficientBalance { id: nid, .. } => nid == id,
        GameNotification::GameSettled { id: nid, .. } => nid == id,
        GameNotification::GameStatus {
            id: nid, status, ..
        } => nid == id && is_terminal_game_status(status),
        _ => false,
    }
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
                (
                    GameNotification::GameSettled { outcome, .. },
                    ExpectedNotification::GameSettledOurSide,
                ) => is_our_side_settlement(*outcome),
                (
                    GameNotification::GameSettled { outcome, .. },
                    ExpectedNotification::GameSettledOpponentSide,
                ) => is_opponent_side_settlement(*outcome),
                (
                    GameNotification::GameStatus {
                        status: GameStatusKind::EndedCancelled,
                        ..
                    },
                    ExpectedNotification::GameStatusEndedCancelled,
                ) => true,
                (
                    GameNotification::GameStatus {
                        status: GameStatusKind::IllegalMoveDetected,
                        ..
                    },
                    ExpectedNotification::GameStatusIllegalMoveDetected,
                ) => true,
                (
                    GameNotification::GameSettled {
                        outcome: SettlementOutcome::SlashedOpponent,
                        ..
                    },
                    ExpectedNotification::GameSettledSlashedOpponent,
                ) => true,
                (
                    GameNotification::GameSettled {
                        outcome: SettlementOutcome::OpponentSlashedUs,
                        ..
                    },
                    ExpectedNotification::GameSettledOpponentSlashedUs,
                ) => true,
                (
                    GameNotification::GameSettled {
                        outcome: SettlementOutcome::OpponentCheated,
                        ..
                    },
                    ExpectedNotification::GameSettledOpponentCheated,
                ) => true,
                (
                    GameNotification::GameStatus {
                        status: GameStatusKind::OnChainTheirTurn,
                        other_params: Some(params),
                        ..
                    },
                    ExpectedNotification::GameStatusMovedByUs,
                ) => params.moved_by_us.unwrap_or(false),
                (
                    GameNotification::GameStatus {
                        status:
                            GameStatusKind::OnChainMyTurn
                            | GameStatusKind::OnChainTheirTurn
                            | GameStatusKind::Replaying,
                        ..
                    },
                    ExpectedNotification::GameStatusOnChainTurn,
                ) => true,
                (
                    GameNotification::GameStatus {
                        status: GameStatusKind::EndedError,
                        ..
                    },
                    ExpectedNotification::GameStatusEndedError,
                ) => true,
                (GameNotification::ProposalMade { .. }, ExpectedNotification::ProposalMade) => true,
                (
                    GameNotification::ProposalAccepted { .. },
                    ExpectedNotification::ProposalAccepted,
                ) => true,
                (
                    GameNotification::ProposalCancelled { .. },
                    ExpectedNotification::ProposalCancelled,
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
                    ExpectedNotification::ChannelStatus(expected_state),
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
            GameNotification::GameStatus { id, status, other_params, .. } => {
                if matches!(status, GameStatusKind::OnChainTheirTurn)
                    && other_params
                        .as_ref()
                        .and_then(|p| p.moved_by_us)
                        .unwrap_or(false)
                {
                    return "Notif(GameStatusMovedByUs)".to_string();
                }
                format!("Notif(GameStatus(id={id:?},status={status:?}))")
            }
            GameNotification::GameSettled { id, outcome, our_share, .. } => {
                format!("Notif(GameSettled(id={id:?},outcome={outcome:?},share={our_share:?}))")
            }
            GameNotification::ProposalMade { id, .. } => format!("Notif(ProposalMade(id={id:?}))"),
            GameNotification::ProposalAccepted { id, .. } => format!("Notif(ProposalAccepted(id={id:?}))"),
            GameNotification::ProposalCancelled { id, reason } => format!("Notif(ProposalCancelled(id={id:?},reason={reason:?}))"),
            GameNotification::InsufficientBalance { id, our_balance_short, their_balance_short } => format!("Notif(InsufficientBalance(id={id:?},ours={our_balance_short},theirs={their_balance_short}))"),
            GameNotification::ActionFailed { reason } => format!("Notif(ActionFailed(reason={reason}))"),
            GameNotification::MoveRejected { id, tag, message } => format!("Notif(MoveRejected(id={id:?},tag={tag},message={message}))"),
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
            ExpectedNotification::GameSettledOurSide => "Notif(GameSettledOurSide)".to_string(),
            ExpectedNotification::GameSettledOpponentSide => {
                "Notif(GameSettledOpponentSide)".to_string()
            }
            ExpectedNotification::GameStatusEndedCancelled => {
                "Notif(GameStatusEndedCancelled)".to_string()
            }
            ExpectedNotification::GameStatusIllegalMoveDetected => {
                "Notif(GameStatusIllegalMoveDetected)".to_string()
            }
            ExpectedNotification::GameSettledSlashedOpponent => {
                "Notif(GameSettledSlashedOpponent)".to_string()
            }
            ExpectedNotification::GameSettledOpponentSlashedUs => {
                "Notif(GameSettledOpponentSlashedUs)".to_string()
            }
            ExpectedNotification::GameSettledOpponentCheated => {
                "Notif(GameSettledOpponentCheated)".to_string()
            }
            ExpectedNotification::GameStatusMovedByUs => "Notif(GameStatusMovedByUs)".to_string(),
            ExpectedNotification::GameStatusOnChainTurn => {
                "Notif(GameStatusOnChainTurn)".to_string()
            }
            ExpectedNotification::GameStatusEndedError => "Notif(GameStatusEndedError)".to_string(),
            ExpectedNotification::ProposalMade => "Notif(ProposalMade)".to_string(),
            ExpectedNotification::ProposalAccepted => "Notif(ProposalAccepted)".to_string(),
            ExpectedNotification::ProposalCancelled => "Notif(ProposalCancelled)".to_string(),
            ExpectedNotification::InsufficientBalance => "Notif(InsufficientBalance)".to_string(),
            ExpectedNotification::ChannelStatus(s) => format!("Notif(ChannelStatus(state={s:?}))"),
        },
    }
}

pub fn game_proposed() -> ExpectedEvent {
    ExpectedEvent::Notification(ExpectedNotification::ProposalMade)
}

pub fn game_accepted() -> ExpectedEvent {
    ExpectedEvent::Notification(ExpectedNotification::ProposalAccepted)
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
            GameNotification::GameSettled {
                our_share, coin_id, ..
            } => {
                let our_reward = our_share.clone();
                let reward_coin = coin_id.clone();
                if let Some(ref rc) = reward_coin {
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
                let has_reward = our_reward > Amount::default();
                let has_coin = reward_coin.is_some();
                assert_eq!(
                    has_reward, has_coin,
                    "{label}: our_reward/reward_coin mismatch (has_reward={has_reward}, has_coin={has_coin}): {n:?}"
                );
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

    /// True when every accepted game has exactly one terminal game notification (Rule B forward
    /// direction). Vacuously true if there are no `ProposalAccepted` games.
    pub fn all_accepted_games_have_terminal_notification(&self) -> bool {
        let accepted_ids: HashSet<GameID> = self
            .notifications
            .iter()
            .filter_map(|n| {
                if let GameNotification::ProposalAccepted { id, .. } = n {
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
                    GameNotification::GameSettled { id: nid, .. } => nid == &id,
                    GameNotification::GameStatus {
                        id: nid, status, ..
                    } => nid == &id && is_terminal_game_status(status),
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
                state: ChannelStatus::Active,
                ..
            } => {
                self.channel_created = true;
            }
            GameNotification::GameStatus {
                id,
                status,
                other_params,
                ..
            } => {
                if let Some(params) = other_params {
                    if let Some(readable) = params.readable.clone() {
                        if let Some(mover_share) = params.mover_share.clone() {
                            self.assert_channel_created("opponent_moved");
                            self.opponent_moved_in_game.insert(id.clone());
                            self.opponent_moves.push((
                                id.clone(),
                                0,
                                readable.clone(),
                                mover_share.clone(),
                            ));
                            self.events.push(TestEvent::OpponentMoved {
                                id: id.clone(),
                                state_number: 0,
                                readable,
                                mover_share,
                            });
                        } else {
                            self.assert_channel_created("game_message");
                            self.opponent_messages.push(OpponentMessageInfo {
                                opponent_move_size: self.opponent_moves.len(),
                                opponent_message: readable.clone(),
                            });
                            self.events.push(TestEvent::GameMessage {
                                id: id.clone(),
                                readable,
                            });
                        }
                    }
                }
                self.notifications.push(notification.clone());
                if is_terminal_game_status(status) {
                    self.assert_channel_created("game_terminal");
                    self.game_finished_ids.insert(id.clone());
                    self.events
                        .push(TestEvent::Notification(notification.clone()));
                    return Ok(());
                }
                if matches!(
                    status,
                    GameStatusKind::OnChainMyTurn
                        | GameStatusKind::OnChainTheirTurn
                        | GameStatusKind::Replaying
                        | GameStatusKind::IllegalMoveDetected
                ) {
                    self.events
                        .push(TestEvent::Notification(notification.clone()));
                }
                if matches!(status, GameStatusKind::OnChainTheirTurn)
                    && other_params
                        .as_ref()
                        .and_then(|p| p.moved_by_us)
                        .unwrap_or(false)
                {
                    // Preserve event-count parity for tests expecting a separate GameStatusMovedByUs signal.
                    self.events
                        .push(TestEvent::Notification(notification.clone()));
                } else {
                    self.assert_channel_created("game_status");
                }
            }
            GameNotification::GameSettled { id, .. } => {
                self.assert_channel_created("game_terminal");
                self.game_finished_ids.insert(id.clone());
                self.notifications.push(notification.clone());
                self.events
                    .push(TestEvent::Notification(notification.clone()));
            }
            GameNotification::ProposalMade { id, .. } => {
                self.assert_channel_created("game_proposed");
                self.received_proposal_ids.push(id.clone());
                self.notifications.push(notification.clone());
                self.events
                    .push(TestEvent::Notification(notification.clone()));
            }
            GameNotification::ProposalAccepted { id, .. } => {
                self.assert_channel_created("game_proposal_accepted");
                self.game_accepted_ids.insert(id.clone());
                self.notifications.push(notification.clone());
                self.events
                    .push(TestEvent::Notification(notification.clone()));
            }
            GameNotification::InsufficientBalance { id, .. } => {
                self.assert_channel_created("game_terminal");
                self.game_finished_ids.insert(id.clone());
                self.notifications.push(notification.clone());
                self.events
                    .push(TestEvent::Notification(notification.clone()));
            }
            GameNotification::ChannelStatus { state, .. } => {
                if matches!(state, ChannelStatus::Active) {
                    self.channel_created = true;
                }
                if matches!(
                    state,
                    ChannelStatus::ShuttingDown
                        | ChannelStatus::ResolvedClean
                        | ChannelStatus::ResolvedUnrolled
                        | ChannelStatus::ResolvedStale
                ) {
                    self.assert_channel_created("channel_status");
                }
                if matches!(state, ChannelStatus::ResolvedClean) {
                    self.clean_shutdown_complete = true;
                }
                if matches!(
                    state,
                    ChannelStatus::GoingOnChain
                        | ChannelStatus::Unrolling
                        | ChannelStatus::ResolvedStale
                        | ChannelStatus::Failed
                ) {
                    self.go_on_chain = true;
                    self.got_error = true;
                }
                self.notifications.push(notification.clone());
                if matches!(
                    state,
                    ChannelStatus::GoingOnChain
                        | ChannelStatus::Unrolling
                        | ChannelStatus::ShuttingDown
                        | ChannelStatus::ShutdownTransactionPending
                        | ChannelStatus::ResolvedClean
                        | ChannelStatus::ResolvedUnrolled
                        | ChannelStatus::ResolvedStale
                        | ChannelStatus::Failed
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

type ManagedSyncCradle = TransactionManager<GameSession>;

type GameRunEarlySuccessPredicate<'a> = Option<&'a dyn Fn(usize, &[ManagedSyncCradle]) -> bool>;

pub struct GameRunOutcome {
    pub identities: [ChiaIdentity; 2],
    pub cradles: [ManagedSyncCradle; 2],
    pub local_uis: [LocalTestUIReceiver; 2],
    pub simulator: Simulator,
    pub logs: [Vec<String>; 2],
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
        GameAction::Move(who, gid, _, _)
        | GameAction::FakeMove(who, gid, _, _)
        | GameAction::BadSignatureMove(who, gid, _) => {
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
                | GameNotification::ProposalCancelled { id, .. }
                    if id == gid
            ) || is_terminal_for_id(n, gid)
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
        | GameAction::ProposeNewGameWithTimeout(who, trigger, _)
        | GameAction::ProposeNewGameTheirTurn(who, trigger)
        | GameAction::ProposeKrunkGroup(who, trigger) => match trigger {
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
    private_keys: [ChannelPrivateKeys; 2],
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

    let neutral_pk: PrivateKey = rng.random();
    let neutral_identity = ChiaIdentity::new(allocator, neutral_pk)?;

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

    let cradle1 = GameSession::new_with_keys(
        GameSessionConfig {
            game_types: game_type_map.clone(),
            have_potato: true,
            identity: identities[0].clone(),
            my_contribution: Amount::new(bal),
            their_contribution: Amount::new(bal),
            channel_timeout: Timeout::new(5),
            unroll_timeout: Timeout::new(15),
            reward_puzzle_hash: identities[0].puzzle_hash.clone(),
        },
        private_keys[0].clone(),
    );
    let cradle2 = GameSession::new_with_keys(
        GameSessionConfig {
            game_types: game_type_map.clone(),
            have_potato: false,
            identity: identities[1].clone(),
            my_contribution: Amount::new(bal),
            their_contribution: Amount::new(bal),
            channel_timeout: Timeout::new(5),
            unroll_timeout: Timeout::new(15),
            reward_puzzle_hash: identities[1].puzzle_hash.clone(),
        },
        private_keys[1].clone(),
    );
    let mut cradles = [
        TransactionManager::new(cradle1),
        TransactionManager::new(cradle2),
    ];
    let mut handshake_done = false;
    let mut can_move = false;
    let mut ending = None;

    let mut wait_blocks = None;
    let mut report_backlogs = [Vec::default(), Vec::default()];
    let mut force_destroyed_coins: Vec<CoinString> = Vec::new();
    let mut nerf_transactions_for: u8 = 0;
    let mut nerfed_tx_backlog: Vec<SpendBundle> = Vec::new();
    let mut nerf_messages_for: u8 = 0;
    let mut blocked_coin_reports_for: u8 = 0;
    let mut start_step = 0;
    let mut num_steps = 0;
    let mut logs: [Vec<String>; 2] = [Vec::new(), Vec::new()];
    let mut tamper_next_batch_signature = [false, false];

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
                    | GameAction::AcceptSettlement(_, _)
                    | GameAction::Timeout(_)
                    | GameAction::Cheat(_, _, _)
                    | GameAction::ForceDestroyCoin(_, _)
                    | GameAction::NerfTransactions(_)
                    | GameAction::UnNerfTransactions(_)
                    | GameAction::UnNerfTransactionsFor(_)
                    | GameAction::BlockCoinReports(_)
                    | GameAction::UnblockCoinReports(_)
                    | GameAction::CancelProposal(_, _)
                    | GameAction::CorruptStateNumber(_, _)
                    | GameAction::ForceUnroll(_)
                    | GameAction::NerfMessages(_)
                    | GameAction::UnNerfMessages
                    | GameAction::SaveUnrollSnapshot(_)
                    | GameAction::ForceStaleUnroll(_)
                    | GameAction::InjectRawMessage(_, _)
                    | GameAction::SelfAcceptProposal(_, _)
                    | GameAction::WrongParityProposal(_)
                    | GameAction::InvalidProposalParameters(_)
                    | GameAction::InvalidProposalTimeout(_)
                    | GameAction::BadSignatureMove(_, _, _)
            )
    };
    let has_explicit_go_on_chain = moves_input.iter().any(|m| {
        matches!(
            m,
            GameAction::GoOnChain(_) | GameAction::ForceUnroll(_) | GameAction::ForceStaleUnroll(_)
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
        assert!(
            num_steps < 200,
            "simulation stalled: num_steps={num_steps} move_number={move_number} can_move={can_move} next_action={:?} explicit_go_on_chain={has_explicit_go_on_chain} handshake_finished={handshake_flags:?} channel_created={channel_created_flags:?}",
            moves_input.get(move_number)
        );

        if matches!(wait_blocks, Some((0, _))) {
            wait_blocks = None;
        }

        let t0 = std::time::Instant::now();
        simulator.farm_block(&neutral_identity.puzzle_hash);
        let current_height = simulator.get_current_height();
        if timing_enabled {
            let farm_elapsed = t0.elapsed();
            eprintln!("  step {num_steps}: farm_block {farm_elapsed:.2?}");
        }

        // Coins force-destroyed by test actions are reported as spent to any
        // player that is watching them.
        let forced_destroyed: HashSet<CoinString> = force_destroyed_coins.drain(..).collect();

        if let Some(p) = &pred {
            if p(move_number, &cradles) {
                return Ok(GameRunOutcome {
                    identities: [identities[0].clone(), identities[1].clone()],
                    cradles,
                    local_uis,
                    simulator,
                    logs,
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

            // Feed the full live coin set so the manager reproduces the
            // previous full-coin-set diff exactly.  Force-destroyed coins are
            // dropped from the set so they read as deleted.
            let mut records = simulator.get_all_coin_states();
            if !forced_destroyed.is_empty() {
                records.retain(|rec| !forced_destroyed.contains(&rec.coin));
            }

            if reports_blocked(i, &wait_blocks) || blocked_coin_reports_for & (1 << i) != 0 {
                report_backlogs[i].push((current_height, records));
            } else {
                let t_nb = std::time::Instant::now();
                cradles[i].report_coin_states(allocator, current_height as u64, &records)?;
                if timing_enabled {
                    let nb_elapsed = t_nb.elapsed();
                    if nb_elapsed.as_millis() > 10 {
                        eprintln!("  step {num_steps}: p{i} report_coin_states {nb_elapsed:.2?}");
                    }
                }
            }

            {
                let result = cradles[i].flush_and_collect(allocator)?;

                // Collect coin solution requests, launcher/coin-spend
                // requests from this flush and all subsequent flushes they
                // trigger, processing every other event inline in FIFO order.
                // Outbound transactions are intercepted by the manager and
                // drained after this player's event processing completes.
                let mut pending_events = result.events;
                let mut submissions_to_push: Vec<SpendBundle> = Vec::new();
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
                    let mut need_launcher = false;
                    let mut coin_spend_req: Option<CoinSpendRequest> = None;
                    for event in pending_events.iter() {
                        match event {
                            GameSessionEvent::NeedLauncherCoin => {
                                need_launcher = true;
                            }
                            GameSessionEvent::NeedCoinSpend(req) => {
                                coin_spend_req = Some(req.clone());
                            }
                            GameSessionEvent::OutboundTransaction(tx, _) => {
                                // The manager normally intercepts these; collect
                                // any that still arrive for uniform handling.
                                submissions_to_push.push(tx.clone());
                            }
                            GameSessionEvent::OutboundMessage(msg) => {
                                if nerf_messages_for & (1 << i) != 0 {
                                    continue;
                                }
                                if cradles[i].is_peer_disconnected() {
                                    continue;
                                }
                                let delivered_msg = if tamper_next_batch_signature[i] {
                                    let peer_message: PeerMessage =
                                        bencodex::from_slice(msg).into_gen()?;
                                    if let PeerMessage::Batch {
                                        actions,
                                        mut signatures,
                                        clean_shutdown,
                                    } = peer_message
                                    {
                                        signatures.my_channel_half_signature_peer =
                                            Default::default();
                                        tamper_next_batch_signature[i] = false;
                                        bencodex::to_vec(&PeerMessage::Batch {
                                            actions,
                                            signatures,
                                            clean_shutdown,
                                        })
                                        .into_gen()?
                                    } else {
                                        msg.clone()
                                    }
                                } else {
                                    msg.clone()
                                };
                                let t_msg = std::time::Instant::now();
                                cradles[i ^ 1].deliver_message(&delivered_msg)?;
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
                            GameSessionEvent::Notification(n) => {
                                local_uis[i].notification(n)?;
                            }
                            GameSessionEvent::ReceiveError(e) => {
                                eprintln!("SIM receive error p{i}: {e}");
                                local_uis[i].notification(&GameNotification::ChannelStatus {
                                    state: ChannelStatus::Failed,
                                    advisory: Some(format!("error receiving peer message: {e}")),
                                    coin: None,
                                    our_balance: None,
                                    their_balance: None,
                                    game_allocated: None,
                                    have_potato: None,
                                })?;
                            }
                            GameSessionEvent::CoinSolutionRequest(coin) => {
                                coin_requests.push(coin.clone());
                            }
                            GameSessionEvent::Log(line) => {
                                logs[i].push(line.clone());
                            }
                            GameSessionEvent::WatchCoin { .. } => {}
                        }
                    }

                    let has_followup =
                        need_launcher || coin_spend_req.is_some() || !coin_requests.is_empty();
                    if !has_followup {
                        break;
                    }

                    if i == 0 && need_launcher {
                        cradles[i].provide_launcher_coin(allocator, launcher_coin.clone())?;
                    }

                    if let Some(req) = coin_spend_req {
                        let wallet_bundle = build_wallet_bundle_for_request(
                            allocator,
                            &simulator,
                            &identities[i],
                            &req,
                        )?;
                        cradles[i].provide_coin_spend_bundle(allocator, wallet_bundle)?;
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
                    let follow_up = cradles[i].flush_and_collect(allocator)?;
                    pending_events = follow_up.events;
                }

                // Drain transactions the manager captured during this player's
                // block processing and submit them to the simulator's mempool.
                submissions_to_push.extend(cradles[i].drain_submissions());
                for tx in submissions_to_push.iter() {
                    if nerf_transactions_for & (1 << i) != 0 {
                        nerfed_tx_backlog.push(tx.clone());
                        continue;
                    }
                    let t_tx = std::time::Instant::now();
                    let included_result = simulator.push_transactions(allocator, &tx.spends)?;
                    if timing_enabled {
                        let tx_elapsed = t_tx.elapsed();
                        if tx_elapsed.as_millis() > 10 {
                            eprintln!(
                                "  step {num_steps}: p{i} push_transactions({:?}) {tx_elapsed:.2?}",
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
                for (backlog_height, backlog_records) in report_backlogs[i].iter() {
                    cradles[i].report_coin_states(
                        allocator,
                        *backlog_height as u64,
                        backlog_records,
                    )?;
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
                        let entropy = rng.random();
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
                    | GameAction::ProposeNewGameTheirTurn(who, _trigger)
                    | GameAction::ProposeNewGameWithTimeout(who, _trigger, _) => {
                        let my_turn = matches!(
                            ga,
                            GameAction::ProposeNewGame(_, _)
                                | GameAction::ProposeNewGameWithTimeout(_, _, _)
                        );
                        let timeout = match ga {
                            GameAction::ProposeNewGameWithTimeout(_, _, timeout) => *timeout,
                            _ => 15,
                        };
                        let parameters = if game_type == b"calpoker" {
                            let node = (Amount::new(100), (my_turn, ()))
                                .to_clvm(allocator)
                                .into_gen()?;
                            Program::from_nodeptr(allocator, node)?
                        } else if game_type == b"spacepoker" {
                            let node = (Amount::new(100), (extras.clone(), (my_turn, ())))
                                .to_clvm(allocator)
                                .into_gen()?;
                            Program::from_nodeptr(allocator, node)?
                        } else if game_type == b"debug" {
                            let node = (
                                Amount::new(100),
                                (Amount::new(100), (my_turn, (extras.clone(), ()))),
                            )
                                .to_clvm(allocator)
                                .into_gen()?;
                            Program::from_nodeptr(allocator, node)?
                        } else {
                            extras.clone()
                        };
                        let new_ids = cradles[*who].propose_game(
                            allocator,
                            &GameStart {
                                game_type: GameType(game_type.to_vec()),
                                timeout: Timeout::new(timeout),
                                parameters,
                            },
                        )?;
                        local_uis[*who]
                            .proposed_game_ids
                            .extend(new_ids.iter().cloned());
                    }
                    GameAction::ProposeKrunkGroup(who, _trigger) => {
                        let new_ids = cradles[*who].propose_game(
                            allocator,
                            &GameStart {
                                game_type: GameType(b"krunk".to_vec()),
                                timeout: Timeout::new(15),
                                parameters: Program::from_hex("64")?,
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
                    GameAction::FakeMove(who, gid, readable, move_data) => {
                        if gid_diag_on {
                            gid_diag(&test_name, action_idx, "FakeMove", gid, gid);
                        }
                        let entropy = rng.random();
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
                    GameAction::BadSignatureMove(who, gid, readable) => {
                        if gid_diag_on {
                            gid_diag(&test_name, action_idx, "BadSignatureMove", gid, gid);
                        }
                        tamper_next_batch_signature[*who] = true;
                        let entropy = rng.random();
                        cradles[*who].make_move(allocator, gid, readable.clone(), entropy)?;
                        local_uis[*who].game_accepted_ids.remove(gid);
                        local_uis[*who].opponent_moved_in_game.remove(gid);
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
                    GameAction::UnNerfTransactionsFor(who) => {
                        nerf_transactions_for &= !(1 << *who);
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
                                simulator.push_transactions(allocator, &tx.spends)?;
                            }
                        } else {
                            nerfed_tx_backlog.clear();
                        }
                    }
                    GameAction::BlockCoinReports(who) => {
                        blocked_coin_reports_for |= 1 << *who;
                    }
                    GameAction::UnblockCoinReports(replay) => {
                        blocked_coin_reports_for = 0;
                        if *replay {
                            #[allow(clippy::needless_range_loop)]
                            for i in 0..=1 {
                                for (backlog_height, backlog_records) in report_backlogs[i].iter() {
                                    cradles[i].report_coin_states(
                                        allocator,
                                        *backlog_height as u64,
                                        backlog_records,
                                    )?;
                                }
                                report_backlogs[i].clear();
                            }
                        } else {
                            report_backlogs = [Vec::default(), Vec::default()];
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
                    GameAction::AcceptSettlement(who, gid) => {
                        if gid_diag_on {
                            gid_diag(&test_name, action_idx, "AcceptSettlement", gid, gid);
                        }
                        cradles[*who].accept_settlement(allocator, gid)?;
                    }
                    GameAction::Timeout(_who) => {
                        panic!("Timeout action is not supported in sim tests; use AcceptSettlement(player, game_id)");
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
                        simulator.push_transactions(allocator, &spend.spends)?;
                    }
                    GameAction::SaveUnrollSnapshot(who) => {
                        cradles[*who].save_unroll_snapshot();
                    }
                    GameAction::ForceStaleUnroll(who) => {
                        let spend = cradles[*who].force_stale_unroll_spend(allocator)?;
                        let _included_result =
                            simulator.push_transactions(allocator, &spend.spends)?;
                    }
                    GameAction::InjectRawMessage(who, data) => {
                        cradles[*who].deliver_message(data)?;
                    }
                    GameAction::SelfAcceptProposal(who, gid) => {
                        cradles[*who].self_accept_proposal(allocator, gid)?;
                    }
                    GameAction::WrongParityProposal(who) => {
                        let parameters = if game_type == b"calpoker" {
                            let node = (Amount::new(100), (true, ()))
                                .to_clvm(allocator)
                                .into_gen()?;
                            Program::from_nodeptr(allocator, node)?
                        } else if game_type == b"spacepoker" {
                            let node = (Amount::new(100), (extras.clone(), (true, ())))
                                .to_clvm(allocator)
                                .into_gen()?;
                            Program::from_nodeptr(allocator, node)?
                        } else {
                            extras.clone()
                        };
                        cradles[*who].propose_game(
                            allocator,
                            &GameStart {
                                game_type: GameType(game_type.to_vec()),
                                timeout: Timeout::new(15),
                                parameters,
                            },
                        )?;
                        cradles[*who].flush_pending(allocator)?;
                        cradles[*who].replace_last_message(|msg_envelope| {
                            if let PeerMessage::Batch { actions, signatures, clean_shutdown } = msg_envelope {
                                let mut new_actions = actions.clone();
                                for action in new_actions.iter_mut() {
                                    if let BatchAction::ProposeGroup(ref mut wire) = action {
                                        wire.members[0].game_id = GameID(wire.members[0].game_id.0 ^ 1);
                                    }
                                }
                                Ok(PeerMessage::Batch {
                                    actions: new_actions,
                                    signatures: signatures.clone(),
                                    clean_shutdown: clean_shutdown.clone(),
                                })
                            } else {
                                Err(Error::StrErr(format!(
                                    "WrongParityProposal expected PeerMessage::Batch, got {msg_envelope:?}"
                                )))
                            }
                        })?;
                    }
                    GameAction::InvalidProposalParameters(who) => {
                        let parameters = if game_type == b"calpoker" {
                            let node = (Amount::new(100), (true, ()))
                                .to_clvm(allocator)
                                .into_gen()?;
                            Program::from_nodeptr(allocator, node)?
                        } else if game_type == b"spacepoker" {
                            let node = (Amount::new(100), (extras.clone(), (true, ())))
                                .to_clvm(allocator)
                                .into_gen()?;
                            Program::from_nodeptr(allocator, node)?
                        } else {
                            extras.clone()
                        };
                        cradles[*who].propose_game(
                            allocator,
                            &GameStart {
                                game_type: GameType(game_type.to_vec()),
                                timeout: Timeout::new(15),
                                parameters,
                            },
                        )?;
                        cradles[*who].flush_pending(allocator)?;
                        cradles[*who].replace_last_message(|msg_envelope| {
                            if let PeerMessage::Batch { actions, signatures, clean_shutdown } = msg_envelope {
                                let mut new_actions = actions.clone();
                                for action in new_actions.iter_mut() {
                                    if let BatchAction::ProposeGroup(ref mut wire) = action {
                                        wire.start.parameters = Program::from_hex("80")?;
                                    }
                                }
                                Ok(PeerMessage::Batch {
                                    actions: new_actions,
                                    signatures: signatures.clone(),
                                    clean_shutdown: clean_shutdown.clone(),
                                })
                            } else {
                                Err(Error::StrErr(format!(
                                    "InvalidProposalParameters expected PeerMessage::Batch, got {msg_envelope:?}"
                                )))
                            }
                        })?;
                    }
                    GameAction::InvalidProposalTimeout(who) => {
                        let parameters = if game_type == b"calpoker" {
                            let node = (Amount::new(100), (true, ()))
                                .to_clvm(allocator)
                                .into_gen()?;
                            Program::from_nodeptr(allocator, node)?
                        } else if game_type == b"spacepoker" {
                            let node = (Amount::new(100), (extras.clone(), (true, ())))
                                .to_clvm(allocator)
                                .into_gen()?;
                            Program::from_nodeptr(allocator, node)?
                        } else {
                            extras.clone()
                        };
                        cradles[*who].propose_game(
                            allocator,
                            &GameStart {
                                game_type: GameType(game_type.to_vec()),
                                timeout: Timeout::new(15),
                                parameters,
                            },
                        )?;
                        cradles[*who].flush_pending(allocator)?;
                        cradles[*who].replace_last_message(|msg_envelope| {
                            if let PeerMessage::Batch { actions, signatures, clean_shutdown } = msg_envelope {
                                let mut new_actions = actions.clone();
                                for action in new_actions.iter_mut() {
                                    if let BatchAction::ProposeGroup(ref mut wire) = action {
                                        wire.start.timeout = Timeout::new(0);
                                    }
                                }
                                Ok(PeerMessage::Batch {
                                    actions: new_actions,
                                    signatures: signatures.clone(),
                                    clean_shutdown: clean_shutdown.clone(),
                                })
                            } else {
                                Err(Error::StrErr(format!(
                                    "InvalidProposalTimeout expected PeerMessage::Batch, got {msg_envelope:?}"
                                )))
                            }
                        })?;
                    }
                }
            }
        }
    }

    for (i, lui) in local_uis.iter().enumerate() {
        let channel_failed = lui.notifications.iter().any(|n| {
            matches!(
                n,
                GameNotification::ChannelStatus {
                    state: ChannelStatus::Failed,
                    ..
                }
            )
        });
        assert!(
            lui.channel_created || channel_failed,
            "player {i} never received channel_created or ChannelStatus::Failed notification"
        );
    }

    // Rule A (proposal lifecycle): every proposal-start event (propose_game
    // call on the proposer side, ProposalMade notification on the receiver
    // side) yields exactly one ProposalAccepted or ProposalCancelled.
    // Checked per-player independently.

    // Rule A for proposer side:
    for (i, lui) in local_uis.iter().enumerate() {
        for id in lui.proposed_game_ids.iter() {
            let accepted = lui
                .notifications
                .iter()
                .filter(|n| {
                    matches!(n,
                        GameNotification::ProposalAccepted { id: nid, .. } if nid == id
                    )
                })
                .count();
            let cancelled = lui
                .notifications
                .iter()
                .filter(|n| {
                    matches!(n,
                        GameNotification::ProposalCancelled { id: nid, .. } if nid == id
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

    // Rule A for receiver side:
    for (i, lui) in local_uis.iter().enumerate() {
        for n in lui.notifications.iter() {
            if let GameNotification::ProposalMade { id, .. } = n {
                let accepted = lui
                    .notifications
                    .iter()
                    .filter(|n2| {
                        matches!(n2,
                            GameNotification::ProposalAccepted { id: nid, .. } if nid == id
                        )
                    })
                    .count();
                let cancelled = lui
                    .notifications
                    .iter()
                    .filter(|n2| {
                        matches!(n2,
                            GameNotification::ProposalCancelled { id: nid, .. } if nid == id
                        )
                    })
                    .count();
                assert!(
                    accepted + cancelled == 1,
                    "player {i}: ProposalMade({id:?}) should have exactly one \
                     Accepted or Cancelled, got {accepted} accepted + {cancelled} cancelled.\n\
                     All notifications: {:?}",
                    lui.notifications
                );
            }
        }
    }

    // Rule B (game lifecycle bijection): one-to-one correspondence between
    // ProposalAccepted and terminal game notifications per player per game ID.
    // Every ProposalAccepted has exactly one terminal, and every terminal has
    // a preceding ProposalAccepted.

    // Rule B forward: every ProposalAccepted has exactly one terminal.
    for (i, lui) in local_uis.iter().enumerate() {
        for n in lui.notifications.iter() {
            if let GameNotification::ProposalAccepted { id, .. } = n {
                let terminal_count = lui
                    .notifications
                    .iter()
                    .filter(|n2| is_terminal_for_id(n2, id))
                    .count();
                assert!(
                    terminal_count == 1,
                    "player {i}: ProposalAccepted({id:?}) should have exactly one terminal game notification, got {terminal_count}. All notifications: {:?}",
                    lui.notifications,
                );
            }
        }
    }

    // Rule B reverse: every terminal has a preceding ProposalAccepted.
    for (i, lui) in local_uis.iter().enumerate() {
        let accepted_ids: HashSet<GameID> = lui
            .notifications
            .iter()
            .filter_map(|n| {
                if let GameNotification::ProposalAccepted { id, .. } = n {
                    Some(*id)
                } else {
                    None
                }
            })
            .collect();
        for n in &lui.notifications {
            let terminal_id = match n {
                GameNotification::InsufficientBalance { id, .. } => Some(id),
                GameNotification::GameStatus { id, status, .. }
                    if is_terminal_game_status(status) =>
                {
                    Some(id)
                }
                _ => None,
            };
            if let Some(id) = terminal_id {
                assert!(
                    accepted_ids.contains(id),
                    "player {i}: terminal notification for {id:?} but no ProposalAccepted for that game. \
                     Accepted IDs: {accepted_ids:?}\nAll notifications: {:?}",
                    lui.notifications,
                );
            }
        }
    }

    // Invariant: on-chain statuses only for accepted games.
    for (i, lui) in local_uis.iter().enumerate() {
        let accepted_ids: HashSet<GameID> = lui
            .notifications
            .iter()
            .filter_map(|n| {
                if let GameNotification::ProposalAccepted { id, .. } = n {
                    Some(id.clone())
                } else {
                    None
                }
            })
            .collect();
        for n in &lui.notifications {
            if let GameNotification::GameStatus { id, status, .. } = n {
                if !matches!(
                    status,
                    GameStatusKind::OnChainMyTurn
                        | GameStatusKind::OnChainTheirTurn
                        | GameStatusKind::Replaying
                ) {
                    continue;
                }
                assert!(
                    accepted_ids.contains(id),
                    "player {i}: on-chain status for {id:?} but no ProposalAccepted for that game. \
                     Accepted IDs: {accepted_ids:?}\nAll notifications: {:?}",
                    lui.notifications,
                );
            }
        }
    }

    // Invariant 6: for games that are still live when unrolling starts, the
    // first post-unroll GameStatus classification is one of the allowed
    // unroll-finish statuses.
    fn is_allowed_unroll_finish_status(status: &GameStatusKind) -> bool {
        matches!(
            status,
            GameStatusKind::OnChainMyTurn
                | GameStatusKind::OnChainTheirTurn
                | GameStatusKind::Replaying
                | GameStatusKind::EndedCancelled
                | GameStatusKind::EndedError
        )
    }
    for (i, lui) in local_uis.iter().enumerate() {
        let first_unrolling_idx = lui.notifications.iter().position(|n| {
            matches!(
                n,
                GameNotification::ChannelStatus {
                    state: ChannelStatus::Unrolling,
                    ..
                }
            )
        });
        let Some(unroll_idx) = first_unrolling_idx else {
            continue;
        };

        let accepted_before_unroll: HashSet<GameID> = lui.notifications[..unroll_idx]
            .iter()
            .filter_map(|n| {
                if let GameNotification::ProposalAccepted { id, .. } = n {
                    Some(*id)
                } else {
                    None
                }
            })
            .collect();

        let terminal_before_unroll: HashSet<GameID> = lui.notifications[..unroll_idx]
            .iter()
            .filter_map(|n| match n {
                GameNotification::GameSettled { id, .. } => Some(*id),
                GameNotification::GameStatus { id, status, .. }
                    if is_terminal_game_status(status) =>
                {
                    Some(*id)
                }
                GameNotification::InsufficientBalance { id, .. } => Some(*id),
                _ => None,
            })
            .collect();

        let live_at_unroll: HashSet<GameID> = accepted_before_unroll
            .difference(&terminal_before_unroll)
            .copied()
            .collect();

        for gid in live_at_unroll {
            let first_post_unroll_ok = lui.notifications[unroll_idx..].iter().any(|n| match n {
                GameNotification::GameSettled { id, .. } if *id == gid => true,
                GameNotification::GameStatus { id, status, .. }
                    if *id == gid && is_allowed_unroll_finish_status(status) =>
                {
                    true
                }
                _ => false,
            });
            assert!(
                first_post_unroll_ok,
                "player {i}: game {gid:?} live at unroll but no allowed post-unroll GameStatus/GameSettled found.\n\
                 All notifications: {:?}",
                lui.notifications,
            );
        }
    }

    // Invariant 7: channel state monotonicity.
    fn channel_state_ordinal(s: &ChannelStatus) -> u8 {
        match s {
            ChannelStatus::Handshaking
            | ChannelStatus::WaitingForHeightToOffer
            | ChannelStatus::WaitingForHeightToAccept => 0,
            ChannelStatus::MakingOffer | ChannelStatus::MakingOfferAcceptance => 1,
            ChannelStatus::OfferSent => 2,
            ChannelStatus::TransactionPending => 3,
            ChannelStatus::Active => 4,
            ChannelStatus::ShuttingDown => 5,
            ChannelStatus::ShutdownTransactionPending => 6,
            ChannelStatus::GoingOnChain => 5,
            ChannelStatus::Unrolling => 6,
            ChannelStatus::ResolvedClean
            | ChannelStatus::ResolvedUnrolled
            | ChannelStatus::ResolvedStale
            | ChannelStatus::Failed => 7,
        }
    }
    for (i, lui) in local_uis.iter().enumerate() {
        let mut last_state: Option<ChannelStatus> = None;
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
                    if ord == prev_ord && ord != 3 && ord != 4 && ord != 5 && ord != 6 {
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
        logs,
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
    let pk1: PrivateKey = rng.random();
    let id1 = ChiaIdentity::new(allocator, pk1).expect("ok");
    let pk2: PrivateKey = rng.random();
    let id2 = ChiaIdentity::new(allocator, pk2).expect("ok");

    let private_keys: [ChannelPrivateKeys; 2] = rng.random();
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

pub fn run_spacepoker_container_with_action_list_with_success_predicate(
    allocator: &mut AllocEncoder,
    moves: &[GameAction],
    predicate: GameRunEarlySuccessPredicate,
    per_player_balance: Option<u64>,
) -> Result<GameRunOutcome, Error> {
    let seed_data: [u8; 32] = [1; 32];
    let mut rng = ChaCha8Rng::from_seed(seed_data);
    let pk1: PrivateKey = rng.random();
    let id1 = ChiaIdentity::new(allocator, pk1).expect("ok");
    let pk2: PrivateKey = rng.random();
    let id2 = ChiaIdentity::new(allocator, pk2).expect("ok");

    let private_keys: [ChannelPrivateKeys; 2] = rng.random();
    let identities: [ChiaIdentity; 2] = [id1.clone(), id2.clone()];
    let bet_unit = 10i64.to_clvm(allocator).into_gen()?;
    let spacepoker_parameters = Program::from_nodeptr(allocator, bet_unit)?;
    run_game_container_with_action_list_with_success_predicate(
        allocator,
        &mut rng,
        private_keys,
        &identities,
        b"spacepoker",
        &spacepoker_parameters,
        moves,
        predicate,
        per_player_balance,
    )
}

pub fn run_spacepoker_container_with_action_list(
    allocator: &mut AllocEncoder,
    moves: &[GameAction],
) -> Result<GameRunOutcome, Error> {
    run_spacepoker_container_with_action_list_with_success_predicate(allocator, moves, None, None)
}

pub fn run_krunk_container_with_action_list_with_success_predicate(
    allocator: &mut AllocEncoder,
    moves: &[GameAction],
    predicate: GameRunEarlySuccessPredicate,
    per_player_balance: Option<u64>,
) -> Result<GameRunOutcome, Error> {
    let seed_data: [u8; 32] = [1; 32];
    let mut rng = ChaCha8Rng::from_seed(seed_data);
    let pk1: PrivateKey = rng.random();
    let id1 = ChiaIdentity::new(allocator, pk1).expect("ok");
    let pk2: PrivateKey = rng.random();
    let id2 = ChiaIdentity::new(allocator, pk2).expect("ok");

    let private_keys: [ChannelPrivateKeys; 2] = rng.random();
    let identities: [ChiaIdentity; 2] = [id1.clone(), id2.clone()];
    run_game_container_with_action_list_with_success_predicate(
        allocator,
        &mut rng,
        private_keys,
        &identities,
        b"krunk",
        &Program::from_hex("64")?,
        moves,
        predicate,
        per_player_balance,
    )
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

fn calpoker_test_moves_with_selected_cards(
    allocator: &mut AllocEncoder,
    game_id: GameID,
    alice_selected: &[usize],
    bob_selected: &[usize],
) -> Vec<GameAction> {
    let alice_word = b"0alice6789abcdef";
    let bob_seed = b"0bob456789abcdef";
    let alice_word_hash = crate::common::types::Sha256Input::Bytes(alice_word)
        .hash()
        .to_clvm(allocator)
        .expect("should work");
    let bob_word = allocator
        .encode_atom(clvm_traits::Atom::Borrowed(bob_seed))
        .expect("should work");
    let nil_move = Program::from_hex("80").expect("should build nil move");
    let alice_picks = alice_selected
        .to_vec()
        .to_clvm(allocator)
        .expect("should work");
    let bob_picks = bob_selected
        .to_vec()
        .to_clvm(allocator)
        .expect("should work");

    vec![
        GameAction::Move(
            0,
            game_id.clone(),
            ReadableMove::from_program(Rc::new(
                Program::from_nodeptr(allocator, alice_word_hash).expect("good"),
            )),
            true,
        ),
        GameAction::Move(
            1,
            game_id.clone(),
            ReadableMove::from_program(Rc::new(
                Program::from_nodeptr(allocator, bob_word).expect("good"),
            )),
            true,
        ),
        GameAction::Move(
            0,
            game_id.clone(),
            ReadableMove::from_program(Rc::new(
                Program::from_nodeptr(allocator, alice_picks).expect("good"),
            )),
            true,
        ),
        GameAction::Move(
            1,
            game_id.clone(),
            ReadableMove::from_program(Rc::new(
                Program::from_nodeptr(allocator, bob_picks).expect("good"),
            )),
            true,
        ),
        GameAction::Move(
            0,
            game_id,
            ReadableMove::from_program(Rc::new(nil_move)),
            true,
        ),
    ]
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
    pub private_keys: [ChannelPrivateKeys; 2],
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
        .push(GameAction::AcceptSettlement(who, GameID(1)));
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
    let pk1: PrivateKey = rng.random();
    let id1 = ChiaIdentity::new(allocator, pk1)?;
    let pk2: PrivateKey = rng.random();
    let id2 = ChiaIdentity::new(allocator, pk2)?;

    let private_keys: [ChannelPrivateKeys; 2] = rng.random();
    let identities: [ChiaIdentity; 2] = [id1.clone(), id2.clone()];

    let pid1 = ChiaIdentity::new(allocator, private_keys[0].my_referee_private_key.clone())?;
    let pid2 = ChiaIdentity::new(allocator, private_keys[1].my_referee_private_key.clone())?;
    let private_identities: [ChiaIdentity; 2] = [pid1, pid2];

    // Player 0 (have_potato=true) allocates odd nonces in this harness.
    // The first proposal from player 0 is therefore GameID(1).
    let first_game_nonce: u64 = 1;
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
    res.push(("krunk_group_accepts_with_exact_stake_balance", &|| {
        let mut allocator = AllocEncoder::new();
        let moves = [
            GameAction::ProposeKrunkGroup(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
        ];
        let outcome = run_krunk_container_with_action_list_with_success_predicate(
            &mut allocator,
            &moves,
            Some(&|move_number, cradles| {
                let proposer = cradles[0]
                    .proposal_contributions_for_testing()
                    .unwrap_or_default();
                let receiver = cradles[1]
                    .proposal_contributions_for_testing()
                    .unwrap_or_default();

                if move_number == 1 && proposer.len() == 2 && receiver.len() == 2 {
                    assert_eq!(
                        proposer,
                        vec![
                            (GameID(1), Amount::new(100), Amount::new(0)),
                            (GameID(3), Amount::new(0), Amount::new(100)),
                        ],
                        "proposer must store proposer-relative contributions",
                    );
                    assert_eq!(
                        receiver,
                        vec![
                            (GameID(1), Amount::new(0), Amount::new(100)),
                            (GameID(3), Amount::new(100), Amount::new(0)),
                        ],
                        "receiver must store mirrored contributions",
                    );
                }

                move_number >= moves.len() && proposer.is_empty() && receiver.is_empty()
            }),
            Some(100),
        )
        .expect("grouped Krunk acceptance should succeed");

        for (player, cradle) in outcome.cradles.iter().enumerate() {
            assert_eq!(
                cradle
                    .allocated_balances_for_testing()
                    .expect("accepted games should remain off chain"),
                (Amount::new(100), Amount::new(100)),
                "player {player} must allocate exactly one stake per participant",
            );
        }

        for (player, ui) in outcome.local_uis.iter().enumerate() {
            assert!(
                !ui.notifications.iter().any(|notification| matches!(
                    notification,
                    GameNotification::InsufficientBalance { .. }
                )),
                "player {player} unexpectedly reported InsufficientBalance: {:?}",
                ui.notifications,
            );
            assert!(
                [GameID(1), GameID(3)]
                    .iter()
                    .all(|id| ui.game_accepted_ids.contains(id)),
                "player {player} did not accept both grouped games",
            );
        }
    }));
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
            let pk1: PrivateKey = rng.random();
            let id1 = ChiaIdentity::new(&mut allocator, pk1).expect("ok");
            let pk2: PrivateKey = rng.random();
            let id2 = ChiaIdentity::new(&mut allocator, pk2).expect("ok");

            let private_keys: [ChannelPrivateKeys; 2] = rng.random();
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
                b"calpoker",
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
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::GoingOnChain,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::Unrolling,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::ResolvedUnrolled,
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
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::GoingOnChain,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::Unrolling,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::ResolvedUnrolled,
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
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentSide),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ShutdownTransactionPending,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedClean,
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
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ShuttingDown,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOurSide),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ShutdownTransactionPending,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedClean,
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

    res.push(("test_clean_shutdown_no_games_nerf_p0", &|| {
        let mut allocator = AllocEncoder::new();
        let moves = vec![
            GameAction::NerfTransactions(0),
            GameAction::CleanShutdown(1),
        ];
        let outcome =
            run_calpoker_container_with_action_list(&mut allocator, &moves).expect("should finish");

        for i in 0..2 {
            assert!(
                outcome.local_uis[i].clean_shutdown_complete,
                "player {i} should reach ResolvedClean"
            );
            assert!(
                outcome.cradles[i].snapshot_watched_coins().len() <= 1,
                "clean shutdown without games should poll at most the channel coin for player {i}, got {:?}",
                outcome.cradles[i].snapshot_watched_coins(),
            );
            let has_failed = outcome.local_uis[i].notifications.iter().any(|n| {
                matches!(
                    n,
                    GameNotification::ChannelStatus {
                        state: ChannelStatus::Failed,
                        ..
                    }
                )
            });
            assert!(
                !has_failed,
                "player {i} should not hit ChannelStatus::Failed, got: {:?}",
                outcome.local_uis[i].notifications
            );
        }
    }));

    res.push(("test_clean_shutdown_no_games_nerf_p1", &|| {
        let mut allocator = AllocEncoder::new();
        let moves = vec![
            GameAction::NerfTransactions(1),
            GameAction::CleanShutdown(1),
        ];
        let outcome =
            run_calpoker_container_with_action_list(&mut allocator, &moves).expect("should finish");

        for i in 0..2 {
            assert!(
                outcome.local_uis[i].clean_shutdown_complete,
                "player {i} should reach ResolvedClean"
            );
            assert!(
                outcome.cradles[i].snapshot_watched_coins().len() <= 1,
                "clean shutdown without games should poll at most the channel coin for player {i}, got {:?}",
                outcome.cradles[i].snapshot_watched_coins(),
            );
            let has_failed = outcome.local_uis[i].notifications.iter().any(|n| {
                matches!(
                    n,
                    GameNotification::ChannelStatus {
                        state: ChannelStatus::Failed,
                        ..
                    }
                )
            });
            assert!(
                !has_failed,
                "player {i} should not hit ChannelStatus::Failed, got: {:?}",
                outcome.local_uis[i].notifications
            );
        }
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
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::GoingOnChain,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::Unrolling,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::ResolvedUnrolled,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                    ExpectedEvent::OpponentMoved {
                        mover_share: Amount::new(0),
                    },
                    // Alice reaches step e but lost — skip heuristic fires,
                    // she doesn't submit her losing final move.
                    ExpectedEvent::Notification(ExpectedNotification::GameSettledOurSide),
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
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::GoingOnChain,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::Unrolling,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::ResolvedUnrolled,
                    )),
                    // Bob replays his moves on-chain; Alice skips her losing
                    // step e so Bob never sees her final move.  Alice times out.
                    ExpectedEvent::Notification(ExpectedNotification::GameStatusMovedByUs),
                    ExpectedEvent::Notification(ExpectedNotification::GameStatusMovedByUs),
                    ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentSide),
                ],
                "piss_off_complete p1",
            );
        },
    ));

    res.push(("failed_final_move_bad_signature_does_not_queue_accept_settlement", &|| {
        let mut allocator = AllocEncoder::new();

        let mut moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
        ];
        let mut hand_moves = prefix_test_moves(&mut allocator, GameID(1));
        let final_move = hand_moves
            .pop()
            .expect("calpoker fixture should include a final move");
        moves.extend(hand_moves);
        if let GameAction::Move(player, game_id, readable, _) = final_move {
            moves.push(GameAction::BadSignatureMove(player, game_id, readable));
        } else {
            panic!("calpoker final fixture move should be a Move");
        }
        moves.push(GameAction::WaitBlocks(120, 0));

        let outcome = run_calpoker_container_with_action_list(&mut allocator, &moves)
            .unwrap_or_else(|e| panic!("should finish bad-signature final move test, got: {e:?}"));

        assert!(
            outcome.local_uis[1].got_error,
            "Bob should be forced on-chain by the malformed final move"
        );

        let p1_notifs = &outcome.local_uis[1].notifications;
        assert!(
            !p1_notifs.iter().any(|n| matches!(
                n,
                GameNotification::GameSettled {
                    outcome: SettlementOutcome::AcceptSettlement | SettlementOutcome::WeAccepted,
                    ..
                }
            )),
            "Bob must not process an AcceptSettlement queued by a final move whose batch failed signature validation, got: {p1_notifs:?}"
        );
    }));

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
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::GoingOnChain,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::Unrolling,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::ResolvedUnrolled,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::GameSettledOurSide),
                ],
                "after_start p0",
            );
            assert_event_sequence(
                &outcome.local_uis[1].events,
                &[
                    game_proposed(),
                    game_accepted(),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::GoingOnChain,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::Unrolling,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::ResolvedUnrolled,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentSide),
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
                    ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentSide),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::GoingOnChain,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::Unrolling,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::ResolvedUnrolled,
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
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::GoingOnChain,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::Unrolling,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::GameSettledOurSide),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::ResolvedUnrolled,
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
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::GoingOnChain,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::Unrolling,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::ResolvedUnrolled,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentSide),
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
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::GoingOnChain,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::Unrolling,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                    ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                        ChannelStatus::ResolvedUnrolled,
                    )),
                    ExpectedEvent::Notification(ExpectedNotification::GameSettledOurSide),
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
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusIllegalMoveDetected),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledSlashedOpponent),
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
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusMovedByUs),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentSlashedUs),
            ],
            "piss_off_slash p1",
        );
    }));

    res.push(("test_slash_first_move", &|| {
        let mut allocator = AllocEncoder::new();

        let moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
            GameAction::GoOnChain(0),
            GameAction::Cheat(0, GameID(1), Amount::default()),
            GameAction::WaitBlocks(30, 0),
        ];

        let outcome =
            run_calpoker_container_with_action_list(&mut allocator, &moves).expect("should finish");

        let (p1_balance, p2_balance) = get_balances_from_outcome(&outcome).expect("should work");
        // Bob (player 1) should get all the money via slash because
        // Alice (player 0) cheated on the first move.
        assert_eq!(p2_balance, p1_balance + 200);
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
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusIllegalMoveDetected),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledSlashedOpponent),
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
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusMovedByUs),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentSlashedUs),
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
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusMovedByUs),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentSlashedUs),
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
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusIllegalMoveDetected),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledSlashedOpponent),
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
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentSide),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ShutdownTransactionPending,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedClean,
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
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOurSide),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ShuttingDown,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ShutdownTransactionPending,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedClean,
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
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOurSide),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ShutdownTransactionPending,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedClean,
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
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentSide),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ShuttingDown,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ShutdownTransactionPending,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedClean,
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
        let params1_node = (
            Amount::new(1000),
            (Amount::new(1000), (true, (borrowed.clone(), ()))),
        )
            .to_clvm(&mut allocator)
            .into_gen()
            .expect("encode debug parameters");
        let params1 =
            Program::from_nodeptr(&mut allocator, params1_node).expect("debug parameters");
        let result1 = outcome.cradles[0].propose_game(
            &mut allocator,
            &GameStart {
                game_type: GameType(game_type.to_vec()),
                timeout: Timeout::new(15),
                parameters: params1,
            },
        );

        assert!(result1.is_ok());

        let params2_node = (
            Amount::new(1000),
            (Amount::new(1000), (true, (borrowed.clone(), ()))),
        )
            .to_clvm(&mut allocator)
            .into_gen()
            .expect("encode debug parameters");
        let params2 =
            Program::from_nodeptr(&mut allocator, params2_node).expect("debug parameters");
        let result2 = outcome.cradles[1].propose_game(
            &mut allocator,
            &GameStart {
                game_type: GameType(game_type.to_vec()),
                timeout: Timeout::new(15),
                parameters: params2,
            },
        );

        for _i in 0..100 {
            for c in 0..2 {
                let result = outcome.cradles[c]
                    .flush_and_collect(&mut allocator)
                    .unwrap();
                for event in result.events.iter() {
                    match event {
                        GameSessionEvent::OutboundMessage(msg) => {
                            outcome.cradles[c ^ 1].deliver_message(msg).unwrap();
                        }
                        GameSessionEvent::Notification(n) => {
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
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentSide),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ShutdownTransactionPending,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedClean,
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
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOurSide),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ShuttingDown,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ShutdownTransactionPending,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedClean,
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
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentSide),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ShutdownTransactionPending,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedClean,
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
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOurSide),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ShuttingDown,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ShutdownTransactionPending,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedClean,
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
        // Nerf both so the clean shutdown tx is dropped for both sides.  Once
        // the clean shutdown is abandoned, both managers fall back to unrolling
        // the shared channel coin, and the manager rebroadcasts that unroll
        // every block until it lands.  On a real chain those two competing
        // unrolls are harmless (only one spend of the channel coin can land,
        // the other is rejected), but the simulator's strict mode fails fast on
        // a mempool conflict.  So keep both managers nerfed across the whole
        // channel-coin unroll race: the only spend of the channel coin that
        // reaches the chain is player 0's forced (stale) unroll below.
        moves.push(GameAction::NerfTransactions(0));
        moves.push(GameAction::NerfTransactions(1));
        moves.push(GameAction::CleanShutdown(1));
        // Let messages and nerfed txs fully drain.
        moves.push(GameAction::WaitBlocks(4, 0));
        // Alice force-submits the unroll (simulating a malicious peer).  This
        // direct push bypasses the nerf, so it is the sole channel-coin spend.
        moves.push(GameAction::ForceUnroll(0));
        // Let the forced unroll mine so the channel coin is spent.
        moves.push(GameAction::WaitBlocks(3, 0));
        // Un-nerf only player 0 to drive the resolution: the channel coin is now
        // spent, so player 0's channel-unroll rebroadcast is gated off (its input
        // is gone), but player 0 can still submit the unroll-timeout claim that
        // creates both players' reward coins.  Player 1 stays nerfed and only
        // observes the on-chain unroll, exercising opponent-unroll detection.
        moves.push(GameAction::UnNerfTransactionsFor(0));
        // Wait for the unroll timeout to elapse and reward coins to be created.
        moves.push(GameAction::WaitBlocks(17, 0));

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
                    state: ChannelStatus::Unrolling,
                    ..
                }
            )),
            "player 1 should see Unrolling channel status, got: {p1_notifs:?}"
        );
        assert!(
            p0_notifs.iter().any(|n| matches!(
                n,
                GameNotification::ChannelStatus {
                    state: ChannelStatus::Unrolling,
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
        // Drain nerfed txs/msgs.  Bumped 3->4 to preserve the force-unroll
        // phase timing now that we no longer un-nerf transactions before the
        // force (removing that pre-force action shifts block counts by one).
        moves.push(GameAction::WaitBlocks(4, 0));
        // Un-nerf only messages so the clean-shutdown response can flow; keep
        // BOTH managers' transactions nerfed across the channel-coin unroll
        // race.  Otherwise the per-block rebroadcast resurrects player 0's own
        // "Create unroll" (it has no relative timelock and creates an output),
        // which lands first, spends the channel coin, and advances player 0 out
        // of the force-unrollable phase before ForceUnroll runs.
        moves.push(GameAction::UnNerfMessages);
        // Alice force-submits the unroll.  Both still nerfed, so this is the
        // sole channel-coin spend.
        moves.push(GameAction::ForceUnroll(0));
        // Let the forced unroll mine so the channel coin is spent.
        moves.push(GameAction::WaitBlocks(3, 0));
        // Un-nerf only player 0 to drive resolution: the channel coin is now
        // spent, so player 0's channel-unroll rebroadcast is gated off (input
        // gone), but it can still submit the unroll-timeout claim that creates
        // both players' reward coins.  Player 1 stays nerfed and observes.
        moves.push(GameAction::UnNerfTransactionsFor(0));
        // Wait for the unroll timeout to elapse.
        moves.push(GameAction::WaitBlocks(17, 0));

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
                    state: ChannelStatus::Unrolling,
                    ..
                }
            )),
            "player 1 should see Unrolling channel status, got: {p1_notifs:?}"
        );
        assert!(
            p0_notifs.iter().any(|n| matches!(
                n,
                GameNotification::ChannelStatus {
                    state: ChannelStatus::Unrolling,
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
        // Wait for channel spend inclusion + unroll coin registration + the
        // unroll timeout to fire. At the end of this wait alice's manager
        // submits the unroll-timeout spend, creating the game coin (alice's
        // turn). Bob is never nerfed, so once that game coin reaches its
        // timeout age bob's manager submits the eager timeout claim that spends
        // it — which is what drives the confirmation-based notifications.
        moves.push(GameAction::WaitBlocks(14, 0));
        // Nerf alice from here on (applied before the block where the game coin
        // first appears) so her on-chain redo of the reveal is dropped and the
        // game coin stays at "alice's turn" until bob's timeout claim spends it.
        moves.push(GameAction::NerfTransactions(0));
        // Wait long enough for the game coin timeout to fire and for bob's eager
        // claim to land and confirm.
        moves.push(GameAction::WaitBlocks(110, 0));

        let outcome =
            run_calpoker_container_with_action_list(&mut allocator, &moves).expect("should finish");

        let p0_notifs = &outcome.local_uis[0].notifications;
        let p1_notifs = &outcome.local_uis[1].notifications;
        assert_reward_coin_consistency(p0_notifs, "redo_timeout p0");
        assert_reward_coin_consistency(p1_notifs, "redo_timeout p1");
        assert!(
            p0_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::GameSettled { outcome, .. } if is_our_side_settlement(*outcome))),
            "player 0 should get WeTimedOut (redo move couldn't land), got: {p0_notifs:?}"
        );
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::GameSettled { outcome, .. } if is_opponent_side_settlement(*outcome))),
            "player 1 should get OpponentTimedOut, got: {p1_notifs:?}"
        );

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOurSide),
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
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentSide),
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
                p0_notifs
                    .iter()
                    .any(|n| matches!(n, GameNotification::GameSettled { outcome, .. } if is_our_side_settlement(*outcome))),
                "player 0 (alice) should get WeTimedOut (nerfed, couldn't play move 4), got: {p0_notifs:?}"
            );
            assert!(
                p1_notifs
                    .iter()
                    .any(|n| matches!(n, GameNotification::GameSettled { outcome, .. } if is_opponent_side_settlement(*outcome))),
                "player 1 (bob) should get OpponentTimedOut (claimed timeout), got: {p1_notifs:?}"
            );

            assert_event_sequence(&outcome.local_uis[0].events, &[
                game_accepted(),
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::GoingOnChain)),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::ResolvedUnrolled)),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOurSide),
            ], "bob_redo_alice_timeout p0");
            assert_event_sequence(&outcome.local_uis[1].events, &[
                game_proposed(), game_accepted(),
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::GameMessage,
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::GoingOnChain)),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::ResolvedUnrolled)),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusMovedByUs),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentSide),
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
                .any(|n| matches!(n, GameNotification::GameSettled { outcome, .. } if is_our_side_settlement(*outcome))),
            "player 1 should get WeTimedOut (it was our turn, no move queued), got: {p1_notifs:?}"
        );
        assert!(
            p0_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::GameSettled { outcome, .. } if is_opponent_side_settlement(*outcome))),
            "player 0 should get OpponentTimedOut, got: {p0_notifs:?}"
        );

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentSide),
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
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOurSide),
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
                .any(|n| has_status(n, GameStatusKind::IllegalMoveDetected)),
            "player 0 should get OpponentPlayedIllegalMove, got: {p0_notifs:?}"
        );
        assert!(
            p0_notifs
                .iter()
                .any(|n| has_settled_outcome(n, SettlementOutcome::SlashedOpponent)),
            "player 0 should get WeSlashedOpponent, got: {p0_notifs:?}"
        );

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusIllegalMoveDetected),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledSlashedOpponent),
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
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusMovedByUs),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentSlashedUs),
            ],
            "slash_illegal p1",
        );
    }));

    res.push(("test_notification_opponent_slashed_us", &|| {
        let mut allocator = AllocEncoder::new();

        // 4 moves so that after the redo (bob's discard) it's Alice's
        // turn, allowing Cheat(0) to fire.  Wait for the unroll and redo
        // to complete before issuing the cheat.
        let mut on_chain_moves: Vec<GameAction> = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
        ];
        let game_moves = prefix_test_moves(&mut allocator, GameID(1));
        on_chain_moves.extend(game_moves.into_iter().take(4));
        on_chain_moves.push(GameAction::GoOnChain(0));
        on_chain_moves.push(GameAction::WaitBlocks(8, 0));
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
                .any(|n| has_settled_outcome(n, SettlementOutcome::OpponentSlashedUs)),
            "player 0 (cheater) should get OpponentSlashedUs, got: {p0_notifs:?}"
        );

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusMovedByUs),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentSlashedUs),
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
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusMovedByUs),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusIllegalMoveDetected),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledSlashedOpponent),
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
                .any(|n| has_status(n, GameStatusKind::IllegalMoveDetected)),
            "player 0 should get OpponentPlayedIllegalMove, got: {p0_notifs:?}"
        );
        assert!(
            p0_notifs
                .iter()
                .any(|n| has_settled_outcome(n, SettlementOutcome::SlashedOpponent)),
            "player 0 should get WeSlashedOpponent, got: {p0_notifs:?}"
        );

        let p1_notifs = &outcome.local_uis[1].notifications;
        assert!(
            p1_notifs
                .iter()
                .any(|n| has_settled_outcome(n, SettlementOutcome::OpponentSlashedUs)),
            "player 1 (cheater) should get OpponentSlashedUs, got: {p1_notifs:?}"
        );

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusIllegalMoveDetected),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledSlashedOpponent),
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
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusMovedByUs),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentSlashedUs),
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
                p0_notifs
                    .iter()
                    .any(|n| has_status(n, GameStatusKind::IllegalMoveDetected)),
                "player 0 should get OpponentPlayedIllegalMove, got: {p0_notifs:?}"
            );
            assert!(
                p0_notifs.iter().any(|n| {
                    matches!(
                        n,
                        GameNotification::GameSettled {
                            outcome: SettlementOutcome::OpponentCheated,
                            coin_id: Some(_),
                            ..
                        }
                    )
                }),
                "player 0 should get OpponentSuccessfullyCheated with reward_coin (mover_share=137), got: {p0_notifs:?}"
            );

            assert_event_sequence(&outcome.local_uis[0].events, &[
                game_accepted(),
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::GoingOnChain)),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::ResolvedUnrolled)),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusIllegalMoveDetected),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentCheated),
            ], "nerfed_cheat p0");
            assert_event_sequence(&outcome.local_uis[1].events, &[
                game_proposed(), game_accepted(),
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::GameMessage,
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::GoingOnChain)),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::ResolvedUnrolled)),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusMovedByUs),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentSide),
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
        moves.push(GameAction::AcceptSettlement(0, GameID(1)));
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
                .any(|n| matches!(n, GameNotification::GameSettled { outcome, .. } if is_our_side_settlement(*outcome))),
            "player 0 (who accepted) should get WeTimedOut, got: {p0_notifs:?}"
        );

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOurSide),
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
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusMovedByUs),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentSide),
            ],
            "accept_finished p1",
        );
    }));

    res.push(("test_accept_settlement_nerfed_then_on_chain", &|| {
        let mut allocator = AllocEncoder::new();

        // Bob accepts off-chain (it's his turn after calpoker) but his
        // potato is nerfed so Alice never receives it.  Then Bob goes
        // on-chain.  The unroll resolves to the pre-accept state (Alice
        // never countersigned the accept batch).  Bob should still get
        // WeTimedOut through the on-chain timeout path, which finds the
        // game in pending_settlements.
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
                .any(|n| matches!(n, GameNotification::GameSettled { outcome, .. } if is_our_side_settlement(*outcome))),
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
        sim_setup.game_actions.push(GameAction::AcceptSettlement(1, GameID(1)));
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
            p1_notifs.iter().any(|n| {
                matches!(
                    n,
                    GameNotification::GameSettled {
                        coin_id: Some(_),
                        ..
                    }
                )
            }),
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
            ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::GoingOnChain)),
            ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::Unrolling)),
            ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
            ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::ResolvedUnrolled)),
            ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentSide),
        ], "nerfed_accept p0");
        assert_event_sequence(&outcome.local_uis[1].events, &[
            game_proposed(), game_accepted(),
            ExpectedEvent::OpponentMoved { mover_share: Amount::new(100) },
            ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::GoingOnChain)),
            ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::Unrolling)),
            ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
            ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::ResolvedUnrolled)),
            ExpectedEvent::Notification(ExpectedNotification::GameSettledOurSide),
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
        //     pre_game_ids but not surviving_ids → EndedCancelled.
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
            p0_notifs.iter().any(|n| matches!(n, GameNotification::ProposalCancelled { .. })),
            "Alice should get ProposalCancelled for her proposed game, got: {p0_notifs:?}"
        );

        assert_event_sequence(&outcome.local_uis[0].events[..6], &[
            game_accepted(),
            ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::GoingOnChain)),
            ExpectedEvent::Notification(ExpectedNotification::ProposalCancelled),
            ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::Unrolling)),
            ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
            ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::ResolvedUnrolled)),
        ], "cancellation_nerfed p0 prefix");
        let p0_tail: Vec<String> = outcome.local_uis[0].events[6..].iter().map(event_shape).collect();
        let p0_terminal: Vec<&str> = p0_tail.iter().filter(|s| {
            s.contains("GameSettled")
        }).map(|s| s.as_str()).collect();
        assert_eq!(p0_terminal.len(), 1,
            "cancellation_nerfed p0 should have exactly 1 terminal notification, got {:?}. All events: {:?}",
            p0_terminal, outcome.local_uis[0].events);

        // p1 also sees game B proposed+cancelled because Alice's proposal
        // arrives before Bob goes on-chain.
        let p1_prefix = &outcome.local_uis[1].events[..8];
        assert_event_sequence(p1_prefix, &[
            game_proposed(), game_accepted(),
            ExpectedEvent::Notification(ExpectedNotification::ProposalMade),
            ExpectedEvent::Notification(ExpectedNotification::ProposalCancelled),
            ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::GoingOnChain)),
            ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::Unrolling)),
            ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
            ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::ResolvedUnrolled)),
        ], "cancellation_nerfed p1 prefix");
        let p1_tail: Vec<String> = outcome.local_uis[1].events[7..].iter().map(event_shape).collect();
        let p1_terminal: Vec<&str> = p1_tail.iter().filter(|s| {
            s.contains("GameSettled")
        }).map(|s| s.as_str()).collect();
        assert_eq!(p1_terminal.len(), 1,
            "cancellation_nerfed p1 should have exactly 1 terminal notification, got {:?}. All events: {:?}",
            p1_terminal, outcome.local_uis[1].events);
    }));

    res.push(("test_on_chain_before_any_moves_times_out", &|| {
        let mut allocator = AllocEncoder::new();

        // Create game A during test setup, then go on-chain before any
        // moves. The game coin should time out normally on-chain.
        // EndedCancelled only happens when a game was accepted but never
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
                .any(|n| matches!(n, GameNotification::GameSettled { outcome, .. } if is_our_side_settlement(*outcome))),
            "player 0 should get WeTimedOut (it was their turn, no move made), got: {p0_notifs:?}"
        );
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::GameSettled { outcome, .. } if is_opponent_side_settlement(*outcome))),
            "player 1 should get OpponentTimedOut (claimed timeout), got: {p1_notifs:?}"
        );

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOurSide),
            ],
            "before_any_moves p0",
        );
        assert_event_sequence(
            &outcome.local_uis[1].events,
            &[
                game_proposed(),
                game_accepted(),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentSide),
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
                p0_notifs
                    .iter()
                    .any(|n| has_status(n, GameStatusKind::IllegalMoveDetected)),
                "player 0 should get OpponentPlayedIllegalMove, got: {p0_notifs:?}"
            );
            assert!(
                p0_notifs.iter().any(|n| {
                    matches!(
                        n,
                        GameNotification::GameSettled {
                            outcome: SettlementOutcome::OpponentCheated,
                            coin_id: None,
                            ..
                        }
                    )
                }),
                "player 0 should get OpponentSuccessfullyCheated with no reward (cheat mover_share=0), got: {p0_notifs:?}"
            );

            assert_event_sequence(&outcome.local_uis[0].events, &[
                game_accepted(),
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::GoingOnChain)),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::ResolvedUnrolled)),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusIllegalMoveDetected),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentCheated),
            ], "opp_cheated p0");
            assert_event_sequence(&outcome.local_uis[1].events, &[
                game_proposed(), game_accepted(),
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::GameMessage,
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::GoingOnChain)),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::ResolvedUnrolled)),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusMovedByUs),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentSide),
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
                p0_notifs
                    .iter()
                    .any(|n| has_status(n, GameStatusKind::EndedError))
                || p0_notifs.iter().any(|n| matches!(n, GameNotification::ChannelStatus { state: ChannelStatus::Failed, .. })),
                "player 0 should get GameError or ChannelError when coin is force-destroyed, got: {p0_notifs:?}"
            );

            assert_event_sequence(&outcome.local_uis[0].events, &[
                game_accepted(),
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::GoingOnChain)),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::ResolvedUnrolled)),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusEndedError),
            ], "destroyed p0");
            assert_event_sequence(&outcome.local_uis[1].events, &[
                game_proposed(), game_accepted(),
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::GameMessage,
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::GoingOnChain)),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::ResolvedUnrolled)),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusEndedError),
            ], "destroyed p1");
        },
    ));

    res.push((
        "test_post_handshake_alice_nerfed_bob_unrolls",
        &|| {
            let mut allocator = AllocEncoder::new();
            let seed_data: [u8; 32] = [0; 32];
            let mut rng = ChaCha8Rng::from_seed(seed_data);
            let pk1: PrivateKey = rng.random();
            let id1 = ChiaIdentity::new(&mut allocator, pk1).expect("ok");
            let pk2: PrivateKey = rng.random();
            let id2 = ChiaIdentity::new(&mut allocator, pk2).expect("ok");
            let private_keys: [ChannelPrivateKeys; 2] = rng.random();
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
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::GoingOnChain)),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::ResolvedUnrolled)),
            ], "alice_nerfed p0");
            assert_event_sequence(&outcome.local_uis[1].events, &[
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::GoingOnChain)),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::ResolvedUnrolled)),
            ], "alice_nerfed p1");
        },
    ));

    res.push((
        "test_post_handshake_bob_nerfed_alice_unrolls",
        &|| {
            let mut allocator = AllocEncoder::new();
            let seed_data: [u8; 32] = [0; 32];
            let mut rng = ChaCha8Rng::from_seed(seed_data);
            let pk1: PrivateKey = rng.random();
            let id1 = ChiaIdentity::new(&mut allocator, pk1).expect("ok");
            let pk2: PrivateKey = rng.random();
            let id2 = ChiaIdentity::new(&mut allocator, pk2).expect("ok");
            let private_keys: [ChannelPrivateKeys; 2] = rng.random();
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
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::GoingOnChain)),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::ResolvedUnrolled)),
            ], "bob_nerfed p0");
            assert_event_sequence(&outcome.local_uis[1].events, &[
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::GoingOnChain)),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::ResolvedUnrolled)),
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
                .any(|n| has_status(n, GameStatusKind::EndedError)),
            "some player should get GameError when game coin force-destroyed, got: {all_notifs:?}"
        );

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::GameStatusEndedError),
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
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusMovedByUs),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusEndedError),
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
                all_notifs
                    .iter()
                    .any(|n| has_status(n, GameStatusKind::EndedError)),
                "some player should get GameError when own game coin force-destroyed, got: {all_notifs:?}"
            );

            assert_event_sequence(&outcome.local_uis[0].events, &[
                game_accepted(),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::GoingOnChain)),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::ResolvedUnrolled)),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::Notification(ExpectedNotification::GameStatusEndedError),
            ], "our_turn_spent p0");
            assert_event_sequence(&outcome.local_uis[1].events, &[
                game_proposed(), game_accepted(),
                ExpectedEvent::OpponentMoved { mover_share: Amount::new(0) },
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::GoingOnChain)),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::Unrolling)),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(ChannelStatus::ResolvedUnrolled)),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusMovedByUs),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusEndedError),
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
                    state: ChannelStatus::Failed,
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
                        state: ChannelStatus::Failed,
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
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
            ],
            "state_too_high p0",
        );
        assert_event_sequence(
            &outcome.local_uis[1].events,
            &[
                game_proposed(),
                game_accepted(),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusEndedError),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Failed,
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
                    state: ChannelStatus::Failed,
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
                        state: ChannelStatus::Failed,
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
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
            ],
            "wrong_parity p0",
        );
        assert_event_sequence(
            &outcome.local_uis[1].events,
            &[
                game_proposed(),
                game_accepted(),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusEndedError),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Failed,
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
        // Go on-chain: the unroll is NOT stale from Bob's perspective
        // (he never got the commit).  Alice redoes her commit on-chain,
        // then it's Bob's turn for the seed.  Bob is nerfed so he
        // times out.  Alice's reveal never fires (game ends first).
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
        moves.push(GameAction::GoOnChain(0));
        moves.push(all_moves[4].clone()); // alice reveal — dispatched when it's her turn (never fires, bob times out)
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
                            state: ChannelStatus::Failed,
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
                .any(|n| matches!(n, GameNotification::GameSettled { outcome, .. } if is_opponent_side_settlement(*outcome))),
            "alice should get OpponentTimedOut (bob was nerfed), got: {p0_notifs:?}"
        );
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::GameSettled { outcome, .. } if is_our_side_settlement(*outcome))),
            "bob should get WeTimedOut (nerfed, couldn't play), got: {p1_notifs:?}"
        );

        assert_event_sequence(
            &outcome.local_uis[0].events,
            &[
                game_accepted(),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusMovedByUs),
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOpponentSide),
            ],
            "go_on_chain_then_move p0",
        );
        assert_event_sequence(
            &outcome.local_uis[1].events,
            &[
                game_proposed(),
                game_accepted(),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::GoingOnChain,
                )),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::Unrolling,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::Notification(ExpectedNotification::ChannelStatus(
                    ChannelStatus::ResolvedUnrolled,
                )),
                ExpectedEvent::Notification(ExpectedNotification::GameStatusOnChainTurn),
                ExpectedEvent::OpponentMoved {
                    mover_share: Amount::new(0),
                },
                ExpectedEvent::Notification(ExpectedNotification::GameSettledOurSide),
            ],
            "go_on_chain_then_move p1",
        );
    }));

    // ──────────────────────────────────────────────────────────────────
    // Proposal lifecycle tests
    // ──────────────────────────────────────────────────────────────────

    res.push(("test_proposal_received_before_channel_coin_report", &|| {
        let mut allocator = AllocEncoder::new();

        // Bob's peer messages still arrive, but his watched coin reports are
        // delayed. Alice can observe the channel coin first, enter Active, and
        // send a proposal batch while Bob is still in the handshake handler.
        // Replaying Bob's coin reports must transition him to OffChainPhase and
        // process the queued proposal.
        let moves = vec![
            GameAction::BlockCoinReports(1),
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::UnblockCoinReports(true),
            GameAction::CleanShutdown(0),
        ];

        let outcome = run_calpoker_container_with_action_list_with_success_predicate(
            &mut allocator,
            &moves,
            None,
            Some(200),
        )
        .expect("should finish");

        let p1_notifs = &outcome.local_uis[1].notifications;
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::ProposalMade { .. })),
            "Bob should process the queued proposal after channel coin report, got: {p1_notifs:?}"
        );
        assert!(
            !p1_notifs.iter().any(|n| {
                matches!(
                    n,
                    GameNotification::ChannelStatus {
                        state: ChannelStatus::Failed,
                        ..
                    }
                )
            }),
            "Bob should not fail when proposal arrives before channel coin report, got: {p1_notifs:?}"
        );
    }));

    res.push(("test_proposal_accepts_custom_game_timeout", &|| {
        let mut allocator = AllocEncoder::new();

        let moves = vec![
            GameAction::ProposeNewGameWithTimeout(0, ProposeTrigger::Channel, 27),
            GameAction::AcceptProposal(1, GameID(1)),
            GameAction::WaitBlocks(3, 0),
        ];
        let move_count = moves.len();

        let outcome = run_calpoker_container_with_action_list_with_success_predicate(
            &mut allocator,
            &moves,
            Some(&|move_number, _| move_number >= move_count),
            Some(200),
        )
        .expect("should finish");

        let p1_notifs = &outcome.local_uis[1].notifications;
        assert!(
            p1_notifs.iter().any(|n| {
                matches!(
                    n,
                    GameNotification::ProposalMade { timeout, .. }
                        if timeout.to_u64() == 27
                )
            }),
            "Bob should see ProposalMade with timeout=27, got: {p1_notifs:?}"
        );
        assert!(
            outcome.local_uis[0]
                .notifications
                .iter()
                .any(|n| matches!(n, GameNotification::ProposalAccepted { .. })),
            "Alice should see accepted custom-timeout proposal, got: {:?}",
            outcome.local_uis[0].notifications
        );
    }));

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
                .any(|n| matches!(n, GameNotification::ProposalCancelled { .. })),
            "Alice should see ProposalCancelled, got: {p0_notifs:?}"
        );

        let p1_notifs = &outcome.local_uis[1].notifications;
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::ProposalMade { .. })),
            "Bob should see ProposalMade, got: {p1_notifs:?}"
        );
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::ProposalCancelled { .. })),
            "Bob should see ProposalCancelled, got: {p1_notifs:?}"
        );
    }));

    res.push(("propose_attempt_rejected_when_peer_proposal_pending", &|| {
        let mut allocator = AllocEncoder::new();

        // Alice proposes first. Bob then tries to propose while Alice's
        // proposal is still pending. Bob's local attempt should be rejected
        // (self-cancelled) and must not cancel Alice's proposal remotely.
        let moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::ProposeNewGame(1, ProposeTrigger::Channel),
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
        let p0_proposal_made = p0_notifs
            .iter()
            .filter(|n| matches!(n, GameNotification::ProposalMade { .. }))
            .count();
        assert_eq!(
            p0_proposal_made,
            0,
            "Alice should not receive a peer ProposalMade from Bob's rejected attempt, got: {p0_notifs:?}"
        );

        let p1_notifs = &outcome.local_uis[1].notifications;
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::ProposalCancelled { reason, .. } if reason.is_local())),
            "Bob should see local self-cancel when proposing over pending peer proposal, got: {p1_notifs:?}"
        );
    }));

    res.push((
        "queued_proposal_cancelled_when_peer_proposal_arrives",
        &|| {
            let mut allocator = AllocEncoder::new();

            // Bob does not initially have the potato, so his proposal queues and
            // requests it. Alice then queues a proposal before processing that
            // request. Bob's queued proposal reaches Alice first and supersedes
            // Alice's stale queued proposal.
            let moves = vec![
                GameAction::ProposeNewGame(1, ProposeTrigger::Channel),
                GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
                GameAction::CancelProposal(0, GameID(0)),
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
                p0_notifs.iter().any(|n| {
                    matches!(
                        n,
                        GameNotification::ProposalCancelled {
                            reason: CancelReason::SupersededByIncoming,
                            ..
                        }
                    )
                }),
                "Alice should see SupersededByIncoming for her queued proposal, got: {p0_notifs:?}"
            );
            assert!(
                p0_notifs.iter().any(
                    |n| matches!(n, GameNotification::ProposalMade { id, .. } if *id == GameID(0))
                ),
                "Alice should receive Bob's surviving proposal, got: {p0_notifs:?}"
            );
        },
    ));

    res.push(("test_proposal_accept_then_on_chain", &|| {
        let mut allocator = AllocEncoder::new();

        // No initial game. Alice proposes (50+50), Bob accepts. A
        // WaitBlocks gap lets Alice process Bob's accept before going
        // on-chain. Both sides should see ProposalMade + ProposalAccepted.
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
                .any(|n| matches!(n, GameNotification::ProposalAccepted { .. })),
            "Alice should see ProposalAccepted, got: {p0_notifs:?}"
        );

        let p1_notifs = &outcome.local_uis[1].notifications;
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::ProposalMade { .. })),
            "Bob should see ProposalMade, got: {p1_notifs:?}"
        );
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::ProposalAccepted { .. })),
            "Bob should see ProposalAccepted, got: {p1_notifs:?}"
        );
    }));

    res.push((
        "proposer_side_clean_shutdown_with_pending_proposal_succeeds",
        &|| {
            let mut allocator = AllocEncoder::new();

            // No initial game. Alice proposes, then (before Bob accepts/cancels)
            // Alice initiates clean shutdown. Pending proposals should be cancelled
            // and shutdown should complete cleanly.
            let moves = vec![
                GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
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
                    .any(|n| matches!(n, GameNotification::ProposalCancelled { .. })),
                "Alice should see ProposalCancelled during shutdown, got: {p0_notifs:?}"
            );

            let p1_notifs = &outcome.local_uis[1].notifications;
            assert!(
                p1_notifs
                    .iter()
                    .any(|n| matches!(n, GameNotification::ProposalMade { .. })),
                "Bob should see ProposalMade, got: {p1_notifs:?}"
            );
            assert!(
                p1_notifs
                    .iter()
                    .any(|n| matches!(n, GameNotification::ProposalCancelled { .. })),
                "Bob should see ProposalCancelled during shutdown, got: {p1_notifs:?}"
            );
        },
    ));

    res.push((
        "receiver_side_clean_shutdown_with_pending_proposal_succeeds",
        &|| {
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
                    .any(|n| matches!(n, GameNotification::ProposalCancelled { .. })),
                "Alice should see ProposalCancelled during shutdown, got: {p0_notifs:?}"
            );

            let p1_notifs = &outcome.local_uis[1].notifications;
            assert!(
                p1_notifs
                    .iter()
                    .any(|n| matches!(n, GameNotification::ProposalMade { .. })),
                "Bob should see ProposalMade, got: {p1_notifs:?}"
            );
            assert!(
                p1_notifs
                    .iter()
                    .any(|n| matches!(n, GameNotification::ProposalCancelled { .. })),
                "Bob should see ProposalCancelled during shutdown, got: {p1_notifs:?}"
            );
        },
    ));

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
                .any(|n| matches!(n, GameNotification::ProposalCancelled { .. })),
            "Alice should see ProposalCancelled, got: {p0_notifs:?}"
        );

        let p1_notifs = &outcome.local_uis[1].notifications;
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::ProposalMade { .. })),
            "Bob should see ProposalMade, got: {p1_notifs:?}"
        );
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::ProposalCancelled { .. })),
            "Bob should see ProposalCancelled, got: {p1_notifs:?}"
        );
    }));

    res.push(("test_insufficient_balance_on_accept", &|| {
        let mut allocator = AllocEncoder::new();

        // Initial game A (100+100) consumes all balance (per_player_balance=100).
        // Alice proposes game B (50+50). Bob tries to accept but has
        // insufficient balance. Bob sees ProposalAccepted then
        // InsufficientBalance. Go on-chain to resolve game A.
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
            p1_notifs.iter().any(|n| matches!(
                n,
                GameNotification::ProposalAccepted { id, amount }
                    if *id == GameID(3) && amount.to_u64() == 200
            )),
            "Bob should get ProposalAccepted with game 3's 200-mojo total, got: {p1_notifs:?}"
        );
        assert!(
            p1_notifs
                .iter()
                .any(|n| matches!(n, GameNotification::InsufficientBalance { .. })),
            "Bob should get InsufficientBalance, got: {p1_notifs:?}"
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
                .any(|n| matches!(n, GameNotification::ProposalAccepted { .. })),
            "Alice should see ProposalAccepted (accept wins the race), got: {p0_notifs:?}"
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
        // Un-nerf only player 1 (the forcer) so its unroll-timeout claim drives
        // the stale resolution.  Keep player 0 nerfed: the channel coin is now
        // spent, but the per-block rebroadcast would otherwise resurrect player
        // 0's "preempt unroll" of the freshly-created unroll coin, which (having
        // no relative timelock) lands before the timeout matures and overrides
        // the stale state with player 0's current state -- making the live
        // second game present again and suppressing its GameError.  Player 0
        // stays nerfed and merely observes the stale resolution.
        sim_setup.game_actions.push(GameAction::UnNerfTransactionsFor(1));
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
            p0_notifs.iter().any(|n| matches!(n, GameNotification::ChannelStatus { state: ChannelStatus::ResolvedStale, .. })),
            "player 0 should see ResolvedStale, got: {p0_notifs:?}"
        );
        // The accept round-tripped, so the second game is fully live (not a
        // pending accept). It's absent from the stale unroll → GameError.
        let game_errors: Vec<_> = p0_notifs
            .iter()
            .filter(|n| has_status(n, GameStatusKind::EndedError))
            .collect();
        assert!(
            game_errors.len() == 1,
            "player 0 should get exactly one GameError for the fully-live second game, got: {game_errors:?}, all: {p0_notifs:?}"
        );
        assert!(
            !p0_notifs.iter().any(|n| matches!(n, GameNotification::ChannelStatus { state: ChannelStatus::Failed, .. })),
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
        // Un-nerf only player 1 (the forcer) so its unroll-timeout claim drives
        // the stale resolution; keep player 0 nerfed so the per-block
        // rebroadcast can't resurrect player 0's "preempt unroll" of the new
        // unroll coin (which has no relative timelock, would land before the
        // timeout matures, and would override the stale state -- suppressing the
        // expected GameError).  Player 0 only observes the stale resolution.
        sim_setup.game_actions.push(GameAction::UnNerfTransactionsFor(1));
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
            p0_notifs.iter().any(|n| matches!(n, GameNotification::ChannelStatus { state: ChannelStatus::ResolvedStale, .. })),
            "player 0 should see ResolvedStale, got: {p0_notifs:?}"
        );
        // The redo recovers the first game, but the second game's accept
        // round-tripped (fully live), absent from the stale unroll → GameError.
        let game_errors: Vec<_> = p0_notifs
            .iter()
            .filter(|n| has_status(n, GameStatusKind::EndedError))
            .collect();
        assert!(
            game_errors.len() == 1,
            "player 0 should get exactly one GameError for the fully-live second game, got: {game_errors:?}, all: {p0_notifs:?}"
        );
        assert!(
            !p0_notifs.iter().any(|n| matches!(n, GameNotification::ChannelStatus { state: ChannelStatus::Failed, .. })),
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
        // Un-nerf only player 1 (the forcer) so its unroll-timeout claim drives
        // the stale resolution; keep player 0 nerfed so the per-block
        // rebroadcast can't resurrect player 0's "preempt unroll" of the new
        // unroll coin (which has no relative timelock, would land before the
        // timeout matures, and would override the stale state -- suppressing the
        // expected GameError).  Player 0 only observes the stale resolution.
        sim_setup
            .game_actions
            .push(GameAction::UnNerfTransactionsFor(1));
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
                    state: ChannelStatus::ResolvedStale,
                    ..
                }
            )),
            "player 0 should see ResolvedStale, got: {p0_notifs:?}"
        );
        // First game: coin present but at an old PH → GameError.
        // Second game: accept round-tripped (fully live), absent from stale unroll → GameError.
        let game_errors: Vec<_> = p0_notifs
            .iter()
            .filter(|n| has_status(n, GameStatusKind::EndedError))
            .collect();
        assert!(
            game_errors.len() >= 1,
            "player 0 should get at least one GameError, got: {game_errors:?}, all: {p0_notifs:?}"
        );
        assert!(
            !p0_notifs.iter().any(|n| matches!(
                n,
                GameNotification::ChannelStatus {
                    state: ChannelStatus::Failed,
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
        // Un-nerf only player 1 (the forcer) so its unroll-timeout claim drives
        // the stale resolution; keep player 0 nerfed so the per-block
        // rebroadcast can't resurrect player 0's "preempt unroll" of the new
        // unroll coin (which has no relative timelock, would land before the
        // timeout matures, and would override the stale state -- suppressing the
        // expected GameError/EndedCancelled).  Player 0 only observes.
        sim_setup.game_actions.push(GameAction::UnNerfTransactionsFor(1));
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
            p0_notifs.iter().any(|n| matches!(n, GameNotification::ChannelStatus { state: ChannelStatus::ResolvedStale, .. })),
            "player 0 should see ResolvedStale, got: {p0_notifs:?}"
        );
        // The second game (fully live, round-tripped) is absent → GameError.
        let game_errors: Vec<_> = p0_notifs
            .iter()
            .filter(|n| has_status(n, GameStatusKind::EndedError))
            .collect();
        assert!(
            game_errors.len() == 1,
            "player 0 should get exactly one GameError for the fully-live second game, got: {game_errors:?}, all: {p0_notifs:?}"
        );
        // The third game (in-flight proposal accept) is absent → EndedCancelled.
        let game_cancels: Vec<_> = p0_notifs
            .iter()
            .filter(|n| has_status(n, GameStatusKind::EndedCancelled))
            .collect();
        assert!(
            game_cancels.len() == 1,
            "player 0 should get exactly one EndedCancelled for the in-flight accept, got: {game_cancels:?}, all: {p0_notifs:?}"
        );
        assert!(
            !p0_notifs.iter().any(|n| matches!(n, GameNotification::ChannelStatus { state: ChannelStatus::Failed, .. })),
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
                GameNotification::GameSettled {
                    our_share,
                    coin_id: None,
                    ..
                } if *our_share == Amount::default()
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
        // AcceptSettlement (game moves to pending_settlements but potato
        // never reaches Bob).  Go on-chain.  The coin matches via
        // pending_settlements with accepted=true.  Alice's share is 0
        // so she should get immediate WeTimedOut(0).
        let moves = [DebugGameTestMove::new(0, 0), DebugGameTestMove::new(0, 0)];
        let mut sim_setup = setup_debug_test(&mut allocator, &mut rng, &moves).expect("ok");
        sim_setup.game_actions.push(GameAction::WaitBlocks(5, 0));
        sim_setup.game_actions.push(GameAction::NerfMessages(0));
        sim_setup
            .game_actions
            .push(GameAction::AcceptSettlement(0, GameID(1)));
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
                GameNotification::GameSettled {
                    our_share,
                    coin_id: None,
                    ..
                } if *our_share == Amount::default()
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
        // waiter gets 0.  Bob has no incentive to move (he gets everything
        // on timeout).  Alice gets immediate OpponentTimedOut(0) because
        // it's the opponent's turn and our share is zero.
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
                GameNotification::GameSettled {
                    our_share,
                    coin_id: None,
                    ..
                } if *our_share == Amount::default()
            )),
            "Alice should get OpponentTimedOut with zero reward (opponent's turn, dead game), got: {p0_notifs:?}"
        );
    }));

    res.push(("test_zero_reward_on_chain_move_skipped", &|| {
        let mut allocator = AllocEncoder::new();
        let seed_data: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed_data);

        // Alice makes move 0 (mover_share=100), Bob makes move 1
        // (mover_share=100).  Now it's Alice's turn.  Alice's move 2
        // sets mover_share=200 (giving Bob everything).  Go on-chain,
        // then issue the losing move normally once the unroll completes
        // and it's Alice's turn.  The on-chain handler should detect
        // mover_share == coin_amount and fire WeTimedOut(0) for Alice.
        let moves = [
            DebugGameTestMove::new(100, 0),
            DebugGameTestMove::new(100, 0),
            DebugGameTestMove::new(200, 0),
        ];
        let mut sim_setup = setup_debug_test(&mut allocator, &mut rng, &moves).expect("ok");

        // Extract the third move and issue it after GoOnChain as a normal move.
        let on_chain_move = sim_setup.game_actions.pop().unwrap();

        sim_setup.game_actions.push(GameAction::GoOnChain(0));
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
                GameNotification::GameSettled {
                    our_share,
                    coin_id: None,
                    ..
                } if *our_share == Amount::default()
            )),
            "Alice should get WeTimedOut with zero reward (on-chain move skipped), got: {p0_notifs:?}"
        );
    }));

    res.push(("test_calpoker_losing_step_e_skipped", &|| {
        let mut allocator = AllocEncoder::new();

        // With the deterministic prefix_test_moves seed, Alice loses.
        // Play steps a–d off-chain, then go on-chain.  After the unroll
        // and redo, step e (Alice's losing final move) is issued normally.
        // The on-chain handler should detect mover_share == game_amount
        // at step e and skip the move instead of submitting it.
        let mut moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
        ];
        moves.extend(prefix_test_moves(&mut allocator, GameID(1)));

        // Pop step e and issue it after GoOnChain, as a normal move.
        let step_e = moves.pop().unwrap();
        moves.push(GameAction::GoOnChain(0));
        moves.push(step_e);
        moves.push(GameAction::WaitBlocks(120, 1));
        moves.push(GameAction::WaitBlocks(5, 0));

        let outcome =
            run_calpoker_container_with_action_list(&mut allocator, &moves).expect("should finish");

        let p0_notifs = &outcome.local_uis[0].notifications;
        assert!(
            p0_notifs.iter().any(|n| matches!(
                n,
                GameNotification::GameSettled {
                    outcome: SettlementOutcome::ForfeitedSkippedReveal,
                    our_share,
                    coin_id: None,
                    ..
                } if *our_share == Amount::default()
            )),
            "Alice should get WeTimedOut with zero reward as forfeit, got: {p0_notifs:?}"
        );
    }));

    res.push(("test_calpoker_winning_step_e_on_chain", &|| {
        let mut allocator = AllocEncoder::new();

        // Alice selects the high cards from the deterministic deal, while Bob
        // selects the low cards.  The parsed off-chain result has
        // bob_win_dir == -1, meaning Alice wins.
        let mut moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
        ];
        moves.extend(calpoker_test_moves_with_selected_cards(
            &mut allocator,
            GameID(1),
            &[32, 36, 41, 49],
            &[2, 6, 9, 13],
        ));

        // Pop step e and issue it after GoOnChain, as a normal move.
        let step_e = moves.pop().unwrap();
        moves.push(GameAction::GoOnChain(0));
        moves.push(step_e);
        moves.push(GameAction::WaitBlocks(120, 1));
        moves.push(GameAction::WaitBlocks(5, 0));

        let outcome =
            run_calpoker_container_with_action_list(&mut allocator, &moves).expect("should finish");
        let (p0_balance, p1_balance) = get_balances_from_outcome(&outcome).expect("should work");

        let p0_notifs = &outcome.local_uis[0].notifications;
        let p1_notifs = &outcome.local_uis[1].notifications;

        assert!(
            p0_notifs.iter().any(|n| matches!(
                n,
                GameNotification::GameStatus {
                    status: GameStatusKind::OnChainTheirTurn,
                    other_params: Some(params),
                    ..
                } if params.moved_by_us == Some(true)
                    && params.game_finished == Some(true)
                    && params.forfeited != Some(true)
            )),
            "Alice's winning step e should be submitted on-chain, got: {p0_notifs:?}"
        );
        assert!(
            p1_notifs.iter().any(|n| matches!(
                n,
                GameNotification::GameStatus {
                    status: GameStatusKind::MyTurn,
                    other_params: Some(params),
                    ..
                } if params.readable.is_some()
                    && params.mover_share == Some(Amount::default())
            )),
            "Bob should receive Alice's terminal move readable and mover_share, got: {p1_notifs:?}"
        );
        assert!(
            p0_notifs.iter().any(|n| matches!(
                n,
                GameNotification::GameSettled {
                    outcome: SettlementOutcome::SettledCleanly | SettlementOutcome::OpponentTimedOut | SettlementOutcome::WeAccepted,
                    our_share,
                    ..
                } if *our_share == Amount::new(200)
            )),
            "Alice should receive full-pot timeout reward, got: {p0_notifs:?}"
        );
        assert!(
            p1_notifs.iter().any(|n| matches!(
                n,
                GameNotification::GameSettled {
                    our_share,
                    ..
                } if *our_share == Amount::default()
            )),
            "Bob should receive a terminal settlement with zero share, got: {p1_notifs:?}"
        );
        assert_eq!(
            p0_balance,
            p1_balance + 200,
            "Alice should end with the full pot: p0={p0_balance}, p1={p1_balance}"
        );
    }));

    res.push(("test_calpoker_winning_all_endgame_on_chain", &|| {
        let mut allocator = AllocEncoder::new();

        // Same deterministic deal as test_calpoker_winning_step_e_on_chain:
        // Alice selects the high cards and wins; Bob (the responder) loses
        // and ends with a zero share.  The difference is that the players go
        // on-chain EARLIER: only steps a and b are played off-chain; steps c,
        // d, and e are ALL played on-chain.  This mirrors the live browser
        // repro where the loser (Bob) observes Alice's terminal winning move
        // on chain and must receive both the final readable and a forfeit
        // terminal instead of being left waiting on a phantom turn.
        let mut moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::AcceptProposal(1, GameID(1)),
        ];
        let mut game_moves = calpoker_test_moves_with_selected_cards(
            &mut allocator,
            GameID(1),
            &[32, 36, 41, 49],
            &[2, 6, 9, 13],
        )
        .into_iter();
        let move_a = game_moves.next().expect("move a");
        let move_b = game_moves.next().expect("move b");
        let move_c = game_moves.next().expect("move c");
        let move_d = game_moves.next().expect("move d");
        let move_e = game_moves.next().expect("move e");

        // a, b off-chain.
        moves.push(move_a);
        moves.push(move_b);
        // Go on-chain before c.  The move triggers are event-driven, so c, d
        // and e are each submitted on-chain once the previous on-chain move
        // has been observed by the next mover.
        moves.push(GameAction::GoOnChain(0));
        moves.push(move_c);
        moves.push(move_d);
        moves.push(move_e);
        // Let Alice's terminal e confirm, Bob observe it, and Alice's
        // timeout claim land for the full pot.
        moves.push(GameAction::WaitBlocks(120, 1));
        moves.push(GameAction::WaitBlocks(5, 0));

        let outcome =
            run_calpoker_container_with_action_list(&mut allocator, &moves).expect("should finish");
        let (p0_balance, p1_balance) = get_balances_from_outcome(&outcome).expect("should work");

        let p1_notifs = &outcome.local_uis[1].notifications;

        // Bob (loser) must receive Alice's terminal move readable + mover_share
        // so the UI can display the final hand result.
        assert!(
            p1_notifs.iter().any(|n| matches!(
                n,
                GameNotification::GameStatus {
                    status: GameStatusKind::MyTurn,
                    other_params: Some(params),
                    ..
                } if params.readable.is_some()
                    && params.mover_share == Some(Amount::default())
            )),
            "Bob should receive Alice's terminal move readable and mover_share, got: {p1_notifs:?}"
        );

        // Bob must receive a forfeit terminal, not be stuck on a phantom turn.
        assert!(
            p1_notifs.iter().any(|n| matches!(
                n,
                GameNotification::GameSettled {
                    outcome: SettlementOutcome::ForfeitedOpponentWon,
                    our_share,
                    ..
                } if *our_share == Amount::default()
            )),
            "Bob should receive ForfeitedOpponentWon settlement, got: {p1_notifs:?}"
        );

        assert_eq!(
            p0_balance,
            p1_balance + 200,
            "Alice should end with the full pot: p0={p0_balance}, p1={p1_balance}"
        );
    }));

    res.push(("test_zero_reward_on_chain_accept_settlement", &|| {
        let mut allocator = AllocEncoder::new();
        let seed_data: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed_data);

        // Alice makes move 0 (mover_share=0, giving Alice everything as
        // waiter).  Bob makes move 1 (mover_share=0, giving Bob everything
        // as waiter).  Now it's Alice's turn, her share as mover is 0.
        // Go on-chain, wait for unroll.  Alice calls AcceptSettlement on-chain.
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
        sim_setup.game_actions.push(GameAction::AcceptSettlement(0, GameID(1)));
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
                GameNotification::GameSettled {
                    our_share,
                    coin_id: None,
                    ..
                } if *our_share == Amount::default()
            )),
            "Alice should get WeTimedOut with zero reward (on-chain AcceptSettlement), got: {p0_notifs:?}"
        );
    }));

    res.push(("test_channel_handshake_timeout", &|| {
        let mut allocator = AllocEncoder::new();

        let moves = vec![
            GameAction::NerfTransactions(0),
            GameAction::NerfTransactions(1),
            GameAction::WaitBlocks(10, 0),
        ];

        let outcome = run_calpoker_container_with_action_list_with_success_predicate(
            &mut allocator,
            &moves,
            Some(&|_move_number, _cradles| false),
            None,
        )
        .expect("should finish");

        for i in 0..2 {
            let has_failed = outcome.local_uis[i].notifications.iter().any(|n| {
                matches!(
                    n,
                    GameNotification::ChannelStatus {
                        state: ChannelStatus::Failed,
                        ..
                    }
                )
            });
            assert!(
                has_failed,
                "player {i} should have received ChannelStatus::Failed, got: {:?}",
                outcome.local_uis[i].notifications
            );
        }
    }));

    res.push((
        "test_channel_handshake_alice_nerfed_still_creates_channel",
        &|| {
            let mut allocator = AllocEncoder::new();

            let moves = vec![GameAction::NerfTransactions(0)];

            let outcome = run_calpoker_container_with_action_list_with_success_predicate(
                &mut allocator,
                &moves,
                Some(&|_, cradles| {
                    cradles[0].handshake_finished() && cradles[1].handshake_finished()
                }),
                None,
            )
            .expect("should finish");

            for i in 0..2 {
                assert!(
                    outcome.local_uis[i].channel_created,
                    "player {i} should have channel_created=true, notifications: {:?}",
                    outcome.local_uis[i].notifications
                );
                let has_failed = outcome.local_uis[i].notifications.iter().any(|n| {
                    matches!(
                        n,
                        GameNotification::ChannelStatus {
                            state: ChannelStatus::Failed,
                            ..
                        }
                    )
                });
                assert!(
                    !has_failed,
                    "player {i} should not have ChannelStatus::Failed, got: {:?}",
                    outcome.local_uis[i].notifications
                );
            }
        },
    ));

    res.push((
        "test_channel_handshake_bob_nerfed_still_creates_channel",
        &|| {
            let mut allocator = AllocEncoder::new();

            let moves = vec![GameAction::NerfTransactions(1)];

            let outcome = run_calpoker_container_with_action_list_with_success_predicate(
                &mut allocator,
                &moves,
                Some(&|_, cradles| {
                    cradles[0].handshake_finished() && cradles[1].handshake_finished()
                }),
                None,
            )
            .expect("should finish");

            for i in 0..2 {
                assert!(
                    outcome.local_uis[i].channel_created,
                    "player {i} should have channel_created=true, notifications: {:?}",
                    outcome.local_uis[i].notifications
                );
                let has_failed = outcome.local_uis[i].notifications.iter().any(|n| {
                    matches!(
                        n,
                        GameNotification::ChannelStatus {
                            state: ChannelStatus::Failed,
                            ..
                        }
                    )
                });
                assert!(
                    !has_failed,
                    "player {i} should not have ChannelStatus::Failed, got: {:?}",
                    outcome.local_uis[i].notifications
                );
            }
        },
    ));

    res.push(("test_handshake_era_invalid_batch_goes_on_chain", &|| {
        let mut allocator = AllocEncoder::new();
        let queued_bad_batch = bencodex::to_vec(&PeerMessage::Batch {
            actions: vec![],
            signatures: Default::default(),
            clean_shutdown: None,
        })
        .expect("should encode bad batch");

        let moves = vec![
            GameAction::WaitBlocks(2, 0),
            GameAction::InjectRawMessage(0, queued_bad_batch),
            GameAction::WaitBlocks(20, 0),
        ];

        let outcome = run_calpoker_container_with_action_list_with_success_predicate(
            &mut allocator,
            &moves,
            Some(&|_, cradles| cradles[0].is_on_chain() || cradles[0].is_failed()),
            None,
        )
        .expect("should finish");

        assert!(
            outcome.cradles[0].is_on_chain(),
            "invalid handshake-era future batch should escalate on-chain, got notifications: {:?}",
            outcome.local_uis[0].notifications
        );
        assert!(
            !outcome.cradles[0].is_failed(),
            "invalid handshake-era future batch should not stop at ChannelStatus::Failed"
        );
    }));

    res.push(("test_wrong_parity_proposal_rejected", &|| {
        let mut allocator = AllocEncoder::new();

        let moves = vec![
            GameAction::WaitBlocks(5, 0),
            GameAction::WrongParityProposal(0),
            GameAction::WaitBlocks(20, 0),
        ];

        let outcome = run_calpoker_container_with_action_list_with_success_predicate(
            &mut allocator,
            &moves,
            Some(&|_, cradles| cradles[1].is_on_chain() || cradles[1].is_failed()),
            None,
        )
        .expect("should finish");

        assert!(
            outcome.cradles[1].is_on_chain() || outcome.cradles[1].is_failed(),
            "player 1 should go on-chain or fail after receiving wrong-parity proposal"
        );
    }));

    res.push((
        "test_spacepoker_invalid_proposal_params_disconnects_peer",
        &|| {
            let mut allocator = AllocEncoder::new();

            let moves = vec![
                GameAction::WaitBlocks(5, 0),
                GameAction::InvalidProposalParameters(0),
                GameAction::WaitBlocks(20, 0),
            ];

            let outcome = run_spacepoker_container_with_action_list_with_success_predicate(
                &mut allocator,
                &moves,
                Some(&|_, cradles| cradles[1].is_peer_disconnected()),
                None,
            )
            .expect("should finish");

            assert!(
            outcome.cradles[1].is_peer_disconnected(),
            "player 1 should disconnect after receiving invalid Space Poker proposal parameters"
        );
        },
    ));

    res.push(("test_invalid_proposal_timeout_disconnects_peer", &|| {
        let mut allocator = AllocEncoder::new();

        let moves = vec![
            GameAction::WaitBlocks(5, 0),
            GameAction::InvalidProposalTimeout(0),
            GameAction::WaitBlocks(20, 0),
        ];

        let outcome = run_calpoker_container_with_action_list_with_success_predicate(
            &mut allocator,
            &moves,
            Some(&|_, cradles| cradles[1].is_peer_disconnected()),
            None,
        )
        .expect("should finish");

        assert!(
            outcome.cradles[1].is_peer_disconnected(),
            "player 1 should disconnect after receiving zero proposal timeout"
        );
    }));

    res.push(("test_self_accept_proposal_rejected", &|| {
        let mut allocator = AllocEncoder::new();

        let moves = vec![
            GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
            GameAction::WaitBlocks(3, 0),
            GameAction::SelfAcceptProposal(0, GameID(1)),
            GameAction::WaitBlocks(20, 0),
        ];

        let outcome = run_calpoker_container_with_action_list_with_success_predicate(
            &mut allocator,
            &moves,
            Some(&|_, cradles| cradles[1].is_on_chain() || cradles[1].is_failed()),
            None,
        )
        .expect("should finish");

        assert!(
            outcome.cradles[1].is_on_chain() || outcome.cradles[1].is_failed(),
            "player 1 should go on-chain or fail after peer self-accepted"
        );
    }));

    res
}
