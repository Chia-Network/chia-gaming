use crate::channel_handler::types::{GameStartFailed, ReadableMove};
use crate::common::types::{
    Amount, CoinString, GameID, PuzzleHash, SpendBundle, Timeout,
};
use crate::potato_handler::types::PeerMessage;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum GameNotification {
    GameCancelled { id: GameID },
    WeTimedOut { id: GameID, our_reward: Amount },
    OpponentTimedOut { id: GameID, our_reward: Amount },
    OpponentPlayedIllegalMove { id: GameID },
    WeSlashedOpponent { id: GameID },
    OpponentSlashedUs { id: GameID },
    OpponentSuccessfullyCheated { id: GameID, our_reward: Amount },

    /// The channel or unroll coin is in an unrecoverable state.
    /// Everything is lost.
    ChannelError { reason: String },
    /// A single game coin is in an unrecoverable state.
    GameError { id: GameID, reason: String },

    ChannelCoinSpent,
    UnrollCoinSpent,
}

#[derive(Debug, Clone)]
pub enum Effect {
    // PacketSender
    SendMessage(PeerMessage),

    // ToLocalUI
    Notification(GameNotification),
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
    GameStart {
        ids: Vec<GameID>,
        failed: Option<GameStartFailed>,
    },
    ResyncMove {
        id: GameID,
        state_number: usize,
        is_my_turn: bool,
    },
    HandshakeComplete,
    ShutdownStarted,
    ShutdownComplete {
        reward_coin: Option<CoinString>,
    },
    GoingOnChain {
        reason: String,
    },

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
}

pub fn apply_effects(
    effects: Vec<Effect>,
    allocator: &mut crate::common::types::AllocEncoder,
    system: &mut (impl crate::potato_handler::types::ToLocalUI
              + crate::potato_handler::types::PacketSender
              + crate::potato_handler::types::WalletSpendInterface
              + crate::potato_handler::types::BootstrapTowardWallet),
) -> Result<(), crate::common::types::Error> {
    for effect in effects {
        match effect {
            Effect::SendMessage(msg) => {
                system.send_message(&msg)?;
            }
            Effect::OpponentMoved {
                id,
                state_number,
                readable,
                mover_share,
            } => {
                system.opponent_moved(allocator, &id, state_number, readable, mover_share)?;
            }
            Effect::GameMessage { id, readable } => {
                system.game_message(allocator, &id, readable)?;
            }
            Effect::GameStart { ids, failed } => {
                system.game_start(&ids, failed)?;
            }
            Effect::Notification(notification) => {
                system.game_notification(&notification)?;
            }
            Effect::ResyncMove { .. } => {
                // Handled internally by peer_container before reaching apply_effects
            }
            Effect::HandshakeComplete => {
                system.handshake_complete()?;
            }
            Effect::ShutdownStarted => {
                system.shutdown_started()?;
            }
            Effect::ShutdownComplete { reward_coin } => {
                system.shutdown_complete(reward_coin.as_ref())?;
            }
            Effect::GoingOnChain { reason } => {
                system.going_on_chain(&reason)?;
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
        }
    }
    Ok(())
}
