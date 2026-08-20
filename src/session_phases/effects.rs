use std::collections::VecDeque;

use crate::channel_state::types::ReadableMove;
use crate::channel_state::types::StateUpdateSignatures;
use crate::common::types::{
    Aggsig, Amount, CoinID, CoinSpend, CoinString, GameID, GameType, Hash, Program, ProgramRef,
    PuzzleHash, SpendBundle, Timeout,
};
use crate::session_phases::handshake::{
    CoinSpendRequest, HandshakePayloadB, HandshakePayloadC, HandshakePayloadD, HandshakePayloadE,
    HandshakePayloadF,
};
use crate::session_phases::types::{BatchAction, PeerMessage};

pub fn format_coin(coin: &CoinString) -> String {
    match coin.to_parts() {
        Some((parent, ph, amt)) => {
            format!("parent={} ph={} amt={}", parent, ph, amt)
        }
        None => format!("(unparseable {} bytes)", coin.to_bytes().len()),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ChannelStatus {
    Handshaking,
    WaitingForHeightToOffer,
    WaitingForHeightToAccept,
    OurWalletMakingOffer,
    OurWalletMakingOfferAcceptance,
    OfferSent,
    TransactionPending,
    Active,
    ShuttingDown,
    ShutdownTransactionPending,
    GoingOnChain,
    Unrolling,
    ResolvedClean,
    ResolvedUnrolled,
    ResolvedStale,
    Failed,
}

/// Local host ownership of a session. This does not describe the channel coin
/// or alter the actual protocol lifecycle in [`ChannelStatus`].
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum SessionDisposition {
    AwaitOutboundTerminal,
    Abandoned,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ChannelStatusSnapshot {
    pub state: ChannelStatus,
    #[serde(default)]
    pub session_disposition: Option<SessionDisposition>,
    pub advisory: Option<String>,
    pub coin: Option<CoinString>,
    pub our_balance: Option<Amount>,
    pub their_balance: Option<Amount>,
    pub game_allocated: Option<Amount>,
    pub have_potato: Option<bool>,
    #[serde(default)]
    pub zero_payout: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unroll_initiator: Option<UnrollInitiator>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub semantic_phase: Option<ChannelSemanticPhase>,
    /// Most recent channel state number this side is aware of.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_number: Option<usize>,
    /// State number of the unroll we are publishing, or of the unroll coin
    /// that landed on-chain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unrolling_state_number: Option<usize>,
    /// State number we are (or were) preempting the landed unroll with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preempting_state_number: Option<usize>,
}

impl ChannelStatusSnapshot {
    pub fn new(state: ChannelStatus) -> Self {
        Self {
            state,
            session_disposition: None,
            advisory: None,
            coin: None,
            our_balance: None,
            their_balance: None,
            game_allocated: None,
            have_potato: None,
            zero_payout: None,
            unroll_initiator: None,
            semantic_phase: None,
            state_number: None,
            unrolling_state_number: None,
            preempting_state_number: None,
        }
    }
}

/// Which party caused the observed channel-to-unroll transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnrollInitiator {
    Us,
    Opponent,
}

/// Fine-grained progress within the existing on-chain channel lifecycle.
/// Actor (us vs opponent) is `unroll_initiator`, not this enum.
/// UI copy is an exhaustive map from this enum plus initiator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelSemanticPhase {
    SubmittingChannelSpend,
    Unrolling,
    FindingState,
    Preempting,
    FinishingWaitingTimeout,
    FinishingSpending,
    Resolving,
}

/// Context for a timeout spend that the transaction manager has submitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum TimeoutClaimSemantic {
    ChannelTimeoutFinish,
    GameOpponentTurn { id: GameID },
    GameFinishTimeout { id: GameID },
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GameStatusKind {
    MyTurn,
    TheirTurn,
    OnChainMyTurn,
    OnChainTheirTurn,
    Replaying,
    PlayingMove,
    IllegalMoveDetected,
    FinishingWaitingTimeout,
    FinishingSpending,
    EndedCancelled,
    EndedError,
}

/// How a game settled. See `NAMING_AUDIT.md` § Settlement glossary (UX).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettlementOutcome {
    /// Off-chain voluntary accept of the current mover_share split.
    AcceptSettlement,
    /// On-chain close from an already-terminal state.
    SettledCleanly,
    /// Non-terminal; opponent's timeout path; intent unknown.
    OpponentTimedOut,
    /// Our turn; our move would give them everything; we stop watching.
    ForfeitedSkippedReveal,
    /// Their terminal move completed the game and left us at 0.
    Lost,
    /// We intentionally accepted on-chain at share 0; we stop watching.
    ForfeitedWeAccepted,
    /// Intentional on-chain accept with share > 0.
    WeAccepted,
    /// We had a move; timeout claim landed first.
    AttemptToMoveFailed,
    /// Our turn; we never chose a move; clock expired.
    TimedOutWaitingForOurMove,
    SlashedOpponent,
    OpponentSlashedUs,
    OpponentCheated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailedGameAction {
    MakeMove,
    AcceptSettlement,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct GameStatusOtherParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub readable: Option<ReadableMove>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mover_share: Option<Amount>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub illegal_move_detected: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moved_by_us: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game_finished: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forfeited: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submitting_timeout_claim: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum CancelReason {
    SupersededByIncoming,
    PeerProposalPending,
    GameActive,
    CancelledByPeer,
    CancelledByUs,
    ChannelError,
    WentOnChain,
    CleanShutdown,
}

impl CancelReason {
    pub fn is_local(self) -> bool {
        matches!(
            self,
            Self::SupersededByIncoming | Self::PeerProposalPending | Self::GameActive
        )
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum GameNotification {
    GameStatus {
        id: GameID,
        status: GameStatusKind,
        my_reward: Option<Amount>,
        coin_id: Option<CoinString>,
        reason: Option<String>,
        other_params: Option<GameStatusOtherParams>,
    },

    /// Unified settlement notification (off-chain accept + on-chain outcomes).
    GameSettled {
        id: GameID,
        outcome: SettlementOutcome,
        our_share: Amount,
        coin_id: Option<CoinString>,
    },

    ProposalMade {
        id: GameID,
        /// Full ordered member list; always non-empty (singleton ⇒ `[id]`).
        group_ids: Vec<GameID>,
        my_contribution: Amount,
        their_contribution: Amount,
        timeout: Timeout,
        initial_validation_program_hash: Hash,
        initial_state: ProgramRef,
        game_type: GameType,
        parameters: Program,
    },
    ProposalAccepted {
        id: GameID,
        amount: Amount,
        our_turn: bool,
    },
    ProposalCancelled {
        id: GameID,
        reason: CancelReason,
    },
    InsufficientBalance {
        id: GameID,
        our_balance_short: bool,
        their_balance_short: bool,
    },

    ActionFailed {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<GameID>,
        #[serde(skip_serializing_if = "Option::is_none")]
        action: Option<FailedGameAction>,
        reason: String,
    },
    MoveRejected {
        id: GameID,
        tag: String,
        message: String,
    },
    ChannelStatus(ChannelStatusSnapshot),
}

/// A coin id worth surfacing in the dashboard so the user can look it up in a
/// block explorer. The active phase handler decides which of these apply; in
/// practice this can include multiple simultaneous game coins and payouts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoinOfInterest {
    Channel,
    Unroll,
    UnrollPayout,
    CurrentGame,
    GamePayout,
}

impl CoinOfInterest {
    pub fn label(self) -> &'static str {
        match self {
            CoinOfInterest::Channel => "Channel coin",
            CoinOfInterest::Unroll => "Unroll coin",
            CoinOfInterest::UnrollPayout => "Unroll payout coin",
            CoinOfInterest::CurrentGame => "Current game coin",
            CoinOfInterest::GamePayout => "Game payout coin",
        }
    }
}

impl GameNotification {
    pub fn game_status(id: GameID, status: GameStatusKind) -> Self {
        GameNotification::GameStatus {
            id,
            status,
            my_reward: None,
            coin_id: None,
            reason: None,
            other_params: None,
        }
    }

    pub fn game_settled(
        id: GameID,
        outcome: SettlementOutcome,
        our_share: Amount,
        coin_id: Option<CoinString>,
    ) -> Self {
        GameNotification::GameSettled {
            id,
            outcome,
            our_share,
            coin_id,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub enum GameSessionEvent {
    OutboundMessage(Vec<u8>),
    /// The sole message required before a local terminal transition. The
    /// transaction manager owns its durable handoff and finalization.
    OutboundTerminalMessage(Vec<u8>),
    /// A spend bundle to submit, with the optional absolute height at/after
    /// which it can no longer be included (from an `ASSERT_BEFORE_HEIGHT_ABSOLUTE`
    /// the handler threads explicitly rather than parsing back out of the bundle).
    OutboundTransaction(SpendBundle, Option<u64>),
    Notification(GameNotification),
    Log(String),
    CoinSolutionRequest(CoinString),
    ReceiveError(String),
    NeedCoinSpend(CoinSpendRequest),
    NeedLauncherCoin,
    WatchCoin {
        coin_name: CoinID,
        coin_string: CoinString,
        timeout: Timeout,
        /// Eagerly-built spend to submit once this coin reaches its relative
        /// timeout age.  `None` for coins with no timeout claim.
        spend: Option<SpendBundle>,
        /// Optional UI context emitted only when the manager submits `spend`.
        semantic: Option<TimeoutClaimSemantic>,
    },
}

/// Collect GameSessionEvents in insertion order.
pub type GameSessionEventQueue = VecDeque<GameSessionEvent>;

#[derive(Debug, Clone)]
pub enum Effect {
    // ToLocalUI
    Notify(GameNotification),

    // PacketSender — one variant per peer message type
    PeerHandshakeA(HandshakePayloadB),
    PeerHandshakeB(HandshakePayloadB),
    PeerHandshakeC(HandshakePayloadC),
    PeerHandshakeD(HandshakePayloadD),
    PeerHandshakeE(HandshakePayloadE),
    PeerHandshakeF(HandshakePayloadF),

    NeedLauncherCoinId,
    NeedCoinSpend(CoinSpendRequest),
    PeerBatch {
        actions: Vec<BatchAction>,
        signatures: StateUpdateSignatures,
        clean_shutdown: Option<Box<(Aggsig, ProgramRef)>>,
    },
    PeerCleanShutdownComplete(CoinSpend),
    /// A durable host-owned clean-shutdown handoff. This is intercepted by
    /// `GameSession`; it must never flow through ordinary packet delivery.
    QueueTerminalHandoff(CoinSpend),
    /// This zero-payout local session has no remaining claim to pursue, so it
    /// can terminate without submitting a channel or unroll spend.
    CompleteZeroPayoutShutdown,
    /// Escalate a peer protocol failure through `GameSession`, which owns the
    /// zero-payout abandonment policy.
    GoOnChainAfterPeerError,
    PeerRequestPotato,
    PeerGameMessage(GameID, Vec<u8>),

    // WalletSpendInterface
    /// Submit a spend bundle.  The optional `u64` is the absolute expiry height
    /// (`ASSERT_BEFORE_HEIGHT_ABSOLUTE`) threaded explicitly from the handler so
    /// the transaction manager can track it without running the transaction.
    SpendTransaction(SpendBundle, Option<u64>),
    RegisterCoin {
        coin: CoinString,
        timeout: Timeout,
        name: Option<&'static str>,
        /// Eagerly-built spend the transaction manager should submit once this
        /// coin reaches its relative timeout age.  `None` when there is no
        /// timeout claim to make for this coin.
        spend: Option<SpendBundle>,
        semantic: Option<TimeoutClaimSemantic>,
    },
    RequestPuzzleAndSolution(CoinString),

    // ChannelFundingWallet
    ChannelPuzzleHash(PuzzleHash),
    ReceivedChannelOffer(SpendBundle),

    // Logging — first-class effect so it lands in the FIFO event queue
    // at the correct temporal position.
    Log(String),
}

pub fn apply_effects(
    effects: Vec<Effect>,
    _allocator: &mut crate::common::types::AllocEncoder,
    system: &mut (impl crate::session_phases::types::ToLocalUI
              + crate::session_phases::types::PacketSender
              + crate::session_phases::types::WalletSpendInterface
              + crate::session_phases::types::ChannelFundingWallet),
) -> Result<(), crate::common::types::Error> {
    for effect in effects.into_iter() {
        match effect {
            Effect::Notify(n) => {
                system.notification(&n)?;
            }
            Effect::PeerHandshakeA(msg) => {
                system.send_message(&PeerMessage::HandshakeA(msg))?;
            }
            Effect::PeerHandshakeB(msg) => {
                system.send_message(&PeerMessage::HandshakeB(msg))?;
            }
            Effect::PeerHandshakeC(msg) => {
                system.send_message(&PeerMessage::HandshakeC(msg))?;
            }
            Effect::PeerHandshakeD(msg) => {
                system.send_message(&PeerMessage::HandshakeD(msg))?;
            }
            Effect::PeerHandshakeE(payload) => {
                system.send_message(&PeerMessage::HandshakeE(payload))?;
            }
            Effect::PeerHandshakeF(payload) => {
                system.send_message(&PeerMessage::HandshakeF(payload))?;
            }
            Effect::NeedLauncherCoinId => {
                // Handled by the cradle/WASM layer, not by the trait system.
            }
            Effect::NeedCoinSpend(_) => {
                // Handled by the cradle/WASM layer, not by the trait system.
            }
            Effect::PeerBatch {
                actions,
                signatures,
                clean_shutdown,
            } => {
                system.send_message(&PeerMessage::Batch {
                    actions,
                    signatures,
                    clean_shutdown,
                })?;
            }
            Effect::PeerCleanShutdownComplete(cs) => {
                system.send_message(&PeerMessage::CleanShutdownComplete(cs))?;
            }
            Effect::QueueTerminalHandoff(_) => {
                return Err(crate::common::types::Error::StrErr(
                    "terminal handoff must be intercepted by GameSession".to_string(),
                ));
            }
            Effect::CompleteZeroPayoutShutdown => {}
            Effect::GoOnChainAfterPeerError => {
                return Err(crate::common::types::Error::StrErr(
                    "peer-error escalation must be intercepted by GameSession".to_string(),
                ));
            }
            Effect::PeerRequestPotato => {
                system.send_message(&PeerMessage::RequestPotato(()))?;
            }
            Effect::PeerGameMessage(id, bytes) => {
                system.send_message(&PeerMessage::Message(id, bytes))?;
            }
            Effect::SpendTransaction(bundle, expiry) => {
                system.spend_transaction_and_add_fee(&bundle, expiry)?;
            }
            Effect::RegisterCoin {
                coin,
                timeout,
                name,
                spend,
                semantic,
            } => {
                system.register_coin(&coin, &timeout, name, spend, semantic)?;
            }
            Effect::RequestPuzzleAndSolution(coin) => {
                system.request_puzzle_and_solution(&coin)?;
            }
            Effect::ChannelPuzzleHash(ph) => {
                system.channel_puzzle_hash(&ph)?;
            }
            Effect::ReceivedChannelOffer(bundle) => {
                system.received_channel_offer(&bundle)?;
            }
            Effect::Log(line) => {
                system.log(&line)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Serialize)]
    struct LegacyChannelStatusSnapshot {
        state: ChannelStatus,
        advisory: Option<String>,
        coin: Option<CoinString>,
        our_balance: Option<Amount>,
        their_balance: Option<Amount>,
        game_allocated: Option<Amount>,
        have_potato: Option<bool>,
    }

    #[test]
    fn legacy_channel_status_restores_new_progress_fields_as_unknown() {
        let legacy = LegacyChannelStatusSnapshot {
            state: ChannelStatus::Active,
            advisory: None,
            coin: None,
            our_balance: None,
            their_balance: None,
            game_allocated: None,
            have_potato: None,
        };

        let encoded = bencodex::to_vec(&legacy).expect("serialize legacy snapshot");
        let restored: ChannelStatusSnapshot =
            bencodex::from_slice(&encoded).expect("restore legacy snapshot");

        assert_eq!(restored.zero_payout, None);
        assert_eq!(restored.unroll_initiator, None);
        assert_eq!(restored.semantic_phase, None);
        assert_eq!(restored.state_number, None);
        assert_eq!(restored.unrolling_state_number, None);
        assert_eq!(restored.preempting_state_number, None);
    }

    #[test]
    fn coin_of_interest_labels_describe_coin_provenance() {
        assert_eq!(CoinOfInterest::UnrollPayout.label(), "Unroll payout coin");
        assert_eq!(CoinOfInterest::CurrentGame.label(), "Current game coin");
        assert_eq!(CoinOfInterest::GamePayout.label(), "Game payout coin");
    }
}
