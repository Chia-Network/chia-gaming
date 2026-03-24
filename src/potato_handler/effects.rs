use std::collections::VecDeque;

use crate::channel_handler::types::PotatoSignatures;
use crate::channel_handler::types::ReadableMove;
use crate::common::types::{
    Aggsig, Amount, CoinSpend, CoinString, GameID, ProgramRef, PuzzleHash, SpendBundle, Timeout,
};
use crate::potato_handler::handshake::{CoinSpendRequest, HandshakeB, HandshakeC, HandshakeD};
use crate::potato_handler::types::{BatchAction, PeerMessage};

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
pub enum ChannelState {
    Handshaking,
    OfferSent,
    TransactionPending,
    Active,
    ShuttingDown,
    Unrolling,
    ResolvedClean,
    ResolvedUnrolled,
    ResolvedStale,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelStatusSnapshot {
    pub state: ChannelState,
    pub advisory: Option<String>,
    pub coin: Option<CoinString>,
    pub our_balance: Option<Amount>,
    pub their_balance: Option<Amount>,
    pub game_allocated: Option<Amount>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum GameNotification {
    GameCancelled {
        id: GameID,
    },
    WeTimedOut {
        id: GameID,
        our_reward: Amount,
        reward_coin: Option<CoinString>,
    },
    OpponentTimedOut {
        id: GameID,
        our_reward: Amount,
        reward_coin: Option<CoinString>,
    },
    OpponentPlayedIllegalMove {
        id: GameID,
    },
    WeSlashedOpponent {
        id: GameID,
        reward_coin: CoinString,
        reward_amount: Amount,
    },
    OpponentSlashedUs {
        id: GameID,
    },
    OpponentSuccessfullyCheated {
        id: GameID,
        our_reward: Amount,
        reward_coin: Option<CoinString>,
    },

    /// A single game coin is in an unrecoverable state.
    GameError {
        id: GameID,
        reason: String,
    },

    GameProposed {
        id: GameID,
        my_contribution: Amount,
        their_contribution: Amount,
    },
    GameProposalAccepted {
        id: GameID,
    },
    GameProposalCancelled {
        id: GameID,
        reason: String,
    },
    InsufficientBalance {
        id: GameID,
        our_balance_short: bool,
        their_balance_short: bool,
    },

    WeMoved {
        id: GameID,
        coin: CoinString,
    },
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
    GameOnChain {
        id: GameID,
        coin: CoinString,
        amount: Amount,
        our_turn: bool,
    },
    ActionFailed {
        reason: String,
    },
    ChannelStatus {
        state: ChannelState,
        advisory: Option<String>,
        coin: Option<CoinString>,
        our_balance: Option<Amount>,
        their_balance: Option<Amount>,
        game_allocated: Option<Amount>,
    },
}

#[derive(Debug, Clone, serde::Serialize)]
pub enum CradleEvent {
    OutboundMessage(Vec<u8>),
    OutboundTransaction(SpendBundle),
    Notification(GameNotification),
    DebugLog(String),
    CoinSolutionRequest(CoinString),
    ReceiveError(String),
    NeedCoinSpend(CoinSpendRequest),
    NeedLauncherCoin,
}

/// Collect CradleEvents in insertion order.
pub type CradleEventQueue = VecDeque<CradleEvent>;

#[derive(Debug, Clone)]
pub enum Effect {
    // ToLocalUI
    Notify(GameNotification),

    // PacketSender — one variant per peer message type
    PeerHandshakeA(HandshakeB),
    PeerHandshakeB(HandshakeB),
    PeerHandshakeC(HandshakeC),
    PeerHandshakeD(HandshakeD),
    PeerHandshakeE {
        bundle: SpendBundle,
        signatures: PotatoSignatures,
    },
    PeerHandshakeF {
        bundle: SpendBundle,
    },

    NeedLauncherCoinId,
    NeedCoinSpend(CoinSpendRequest),
    PeerBatch {
        actions: Vec<BatchAction>,
        signatures: PotatoSignatures,
        clean_shutdown: Option<Box<(Aggsig, ProgramRef)>>,
    },
    PeerCleanShutdownComplete(CoinSpend),
    PeerRequestPotato,
    PeerGameMessage(GameID, Vec<u8>),

    // WalletSpendInterface
    SpendTransaction(SpendBundle),
    RegisterCoin {
        coin: CoinString,
        timeout: Timeout,
        name: Option<&'static str>,
    },
    RequestPuzzleAndSolution(CoinString),

    // BootstrapTowardWallet
    ChannelPuzzleHash(PuzzleHash),
    ReceivedChannelOffer(SpendBundle),

    // Debug logging — first-class effect so it lands in the FIFO event queue
    // at the correct temporal position.
    DebugLog(String),
}

pub fn apply_effects(
    effects: Vec<Effect>,
    _allocator: &mut crate::common::types::AllocEncoder,
    system: &mut (impl crate::potato_handler::types::ToLocalUI
              + crate::potato_handler::types::PacketSender
              + crate::potato_handler::types::WalletSpendInterface
              + crate::potato_handler::types::BootstrapTowardWallet),
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
            Effect::PeerHandshakeE { bundle, signatures } => {
                system.send_message(&PeerMessage::HandshakeE { bundle, signatures })?;
            }
            Effect::PeerHandshakeF { bundle } => {
                system.send_message(&PeerMessage::HandshakeF { bundle })?;
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
            Effect::SpendTransaction(bundle) => {
                system.spend_transaction_and_add_fee(&bundle)?;
            }
            Effect::RegisterCoin {
                coin,
                timeout,
                name,
            } => {
                system.register_coin(&coin, &timeout, name)?;
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
            Effect::DebugLog(line) => {
                system.debug_log(&line)?;
            }
        }
    }
    Ok(())
}
