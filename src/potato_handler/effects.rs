use std::collections::VecDeque;

use crate::channel_handler::types::PotatoSignatures;
use crate::channel_handler::types::ReadableMove;
use crate::common::types::{
    Aggsig, Amount, CoinSpend, CoinString, GameID, ProgramRef, PuzzleHash, SpendBundle, Timeout,
};
use crate::potato_handler::handshake::{HandshakeA, HandshakeB};
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

    /// Our preemption lost the race and the opponent's stale unroll resolved.
    /// Per-game outcomes follow as separate notifications.
    StaleChannelUnroll {
        our_reward: Amount,
        reward_coin: Option<CoinString>,
    },

    /// The channel or unroll coin is in an unrecoverable state.
    /// Everything is lost.
    ChannelError {
        reason: String,
    },
    /// A single game coin is in an unrecoverable state.
    GameError {
        id: GameID,
        reason: String,
    },

    ChannelCoinSpent {
        unroll_coin: CoinString,
    },
    UnrollCoinSpent {
        reward_coin: Option<CoinString>,
        reward_amount: Amount,
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
    ChannelCreated {
        channel_coin: CoinString,
    },
    CleanShutdownStarted {},
    CleanShutdownComplete {
        reward_coin: Option<CoinString>,
        reward_amount: Amount,
    },
    GoingOnChain {
        reason: String,
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
}

#[derive(Debug, Clone, serde::Serialize)]
pub enum CradleEvent {
    OutboundMessage(Vec<u8>),
    OutboundTransaction(SpendBundle),
    Notification(GameNotification),
    DebugLog(String),
    CoinSolutionRequest(CoinString),
    ReceiveError(String),
}

/// Collect CradleEvents in insertion order.
pub type CradleEventQueue = VecDeque<CradleEvent>;

#[derive(Debug, Clone)]
pub enum Effect {
    // ToLocalUI
    Notify(GameNotification),

    // PacketSender — one variant per peer message type
    PeerHandshakeA(HandshakeA),
    PeerHandshakeB(HandshakeB),
    PeerHandshakeC {
        signatures: PotatoSignatures,
    },
    PeerHandshakeD {
        signatures: PotatoSignatures,
    },
    PeerHandshakeE {
        bundle: SpendBundle,
    },
    PeerHandshakeF {
        bundle: SpendBundle,
    },
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
            Effect::PeerHandshakeC { signatures } => {
                system.send_message(&PeerMessage::HandshakeC { signatures })?;
            }
            Effect::PeerHandshakeD { signatures } => {
                system.send_message(&PeerMessage::HandshakeD { signatures })?;
            }
            Effect::PeerHandshakeE { bundle } => {
                system.send_message(&PeerMessage::HandshakeE { bundle })?;
            }
            Effect::PeerHandshakeF { bundle } => {
                system.send_message(&PeerMessage::HandshakeF { bundle })?;
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
