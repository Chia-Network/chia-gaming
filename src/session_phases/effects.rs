use std::collections::VecDeque;

use crate::channel_state::types::ReadableMove;
use crate::channel_state::types::StateUpdateSignatures;
use crate::common::types::{
    Aggsig, Amount, CoinID, CoinSpend, CoinString, GameID, GameType, Hash, ProgramRef, PuzzleHash,
    SpendBundle, Timeout,
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

pub struct ResyncInfo {
    pub state_number: usize,
    pub is_my_turn: bool,
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

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ChannelStatusSnapshot {
    pub state: ChannelStatus,
    pub advisory: Option<String>,
    pub coin: Option<CoinString>,
    pub our_balance: Option<Amount>,
    pub their_balance: Option<Amount>,
    pub game_allocated: Option<Amount>,
    pub have_potato: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GameStatusKind {
    MyTurn,
    TheirTurn,
    OnChainMyTurn,
    OnChainTheirTurn,
    Replaying,
    IllegalMoveDetected,
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
    /// Their terminal move left us at 0; we stop watching.
    ForfeitedOpponentWon,
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
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        group_ids: Vec<GameID>,
        my_contribution: Amount,
        their_contribution: Amount,
        timeout: Timeout,
        initial_validation_program_hash: Hash,
        initial_state: ProgramRef,
        game_type: GameType,
    },
    ProposalAccepted {
        id: GameID,
        amount: Amount,
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
        reason: String,
    },
    MoveRejected {
        id: GameID,
        tag: String,
        message: String,
    },
    ChannelStatus {
        state: ChannelStatus,
        advisory: Option<String>,
        coin: Option<CoinString>,
        our_balance: Option<Amount>,
        their_balance: Option<Amount>,
        game_allocated: Option<Amount>,
        #[serde(skip_serializing_if = "Option::is_none")]
        have_potato: Option<bool>,
    },
}

/// A coin id worth surfacing in the dashboard so the user can look it up in a
/// block explorer. The active phase handler decides which of these apply; in
/// practice there are 0-2 at any moment (one channel/settlement-level coin and
/// at most one game-level coin).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoinOfInterest {
    Channel,
    Unroll,
    Change,
    Game,
    GameChange,
}

impl CoinOfInterest {
    pub fn label(self) -> &'static str {
        match self {
            CoinOfInterest::Channel => "Channel coin",
            CoinOfInterest::Unroll => "Unroll coin",
            CoinOfInterest::Change => "Change coin",
            CoinOfInterest::Game => "Game coin",
            CoinOfInterest::GameChange => "Game change coin",
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
            } => {
                system.register_coin(&coin, &timeout, name, spend)?;
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
