use crate::channel_handler::types::ReadableMove;
use crate::common::types::{Amount, CoinString, GameID, PuzzleHash, SpendBundle, Timeout};
use crate::potato_handler::types::PeerMessage;

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

    ChannelCoinSpent,
    UnrollCoinSpent {
        reward_coin: Option<CoinString>,
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
    ChannelCreated,
    CleanShutdownStarted,
    CleanShutdownComplete {
        reward_coin: Option<CoinString>,
    },
    GoingOnChain {
        reason: String,
    },
}

#[derive(Debug, Clone)]
pub enum Effect {
    // PacketSender
    SendMessage(PeerMessage),

    // ToLocalUI — each maps to a GameNotification for delivery
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
    },
    OpponentSlashedUs {
        id: GameID,
    },
    OpponentSuccessfullyCheated {
        id: GameID,
        our_reward: Amount,
        reward_coin: Option<CoinString>,
    },
    StaleChannelUnroll {
        our_reward: Amount,
        reward_coin: Option<CoinString>,
    },
    ChannelError {
        reason: String,
    },
    GameError {
        id: GameID,
        reason: String,
    },
    ChannelCoinSpent,
    UnrollCoinSpent {
        reward_coin: Option<CoinString>,
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
    ChannelCreated,
    CleanShutdownStarted,
    CleanShutdownComplete {
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

impl From<GameNotification> for Effect {
    fn from(n: GameNotification) -> Self {
        match n {
            GameNotification::GameCancelled { id } => Effect::GameCancelled { id },
            GameNotification::WeTimedOut {
                id,
                our_reward,
                reward_coin,
            } => Effect::WeTimedOut {
                id,
                our_reward,
                reward_coin,
            },
            GameNotification::OpponentTimedOut {
                id,
                our_reward,
                reward_coin,
            } => Effect::OpponentTimedOut {
                id,
                our_reward,
                reward_coin,
            },
            GameNotification::OpponentPlayedIllegalMove { id } => {
                Effect::OpponentPlayedIllegalMove { id }
            }
            GameNotification::WeSlashedOpponent { id, reward_coin } => {
                Effect::WeSlashedOpponent { id, reward_coin }
            }
            GameNotification::OpponentSlashedUs { id } => Effect::OpponentSlashedUs { id },
            GameNotification::OpponentSuccessfullyCheated {
                id,
                our_reward,
                reward_coin,
            } => Effect::OpponentSuccessfullyCheated {
                id,
                our_reward,
                reward_coin,
            },
            GameNotification::StaleChannelUnroll {
                our_reward,
                reward_coin,
            } => Effect::StaleChannelUnroll {
                our_reward,
                reward_coin,
            },
            GameNotification::ChannelError { reason } => Effect::ChannelError { reason },
            GameNotification::GameError { id, reason } => Effect::GameError { id, reason },
            GameNotification::ChannelCoinSpent => Effect::ChannelCoinSpent,
            GameNotification::UnrollCoinSpent { reward_coin } => {
                Effect::UnrollCoinSpent { reward_coin }
            }
            GameNotification::GameProposed {
                id,
                my_contribution,
                their_contribution,
            } => Effect::GameProposed {
                id,
                my_contribution,
                their_contribution,
            },
            GameNotification::GameProposalAccepted { id } => Effect::GameProposalAccepted { id },
            GameNotification::GameProposalCancelled { id, reason } => {
                Effect::GameProposalCancelled { id, reason }
            }
            GameNotification::InsufficientBalance {
                id,
                our_balance_short,
                their_balance_short,
            } => Effect::InsufficientBalance {
                id,
                our_balance_short,
                their_balance_short,
            },
            GameNotification::OpponentMoved {
                id,
                state_number,
                readable,
                mover_share,
            } => Effect::OpponentMoved {
                id,
                state_number,
                readable,
                mover_share,
            },
            GameNotification::GameMessage { id, readable } => Effect::GameMessage { id, readable },
            GameNotification::ChannelCreated => Effect::ChannelCreated,
            GameNotification::CleanShutdownStarted => Effect::CleanShutdownStarted,
            GameNotification::CleanShutdownComplete { reward_coin } => {
                Effect::CleanShutdownComplete { reward_coin }
            }
            GameNotification::GoingOnChain { reason } => Effect::GoingOnChain { reason },
        }
    }
}

fn effect_to_notification(effect: &Effect) -> Option<GameNotification> {
    match effect {
        Effect::GameCancelled { id } => Some(GameNotification::GameCancelled { id: *id }),
        Effect::WeTimedOut {
            id,
            our_reward,
            reward_coin,
        } => Some(GameNotification::WeTimedOut {
            id: *id,
            our_reward: our_reward.clone(),
            reward_coin: reward_coin.clone(),
        }),
        Effect::OpponentTimedOut {
            id,
            our_reward,
            reward_coin,
        } => Some(GameNotification::OpponentTimedOut {
            id: *id,
            our_reward: our_reward.clone(),
            reward_coin: reward_coin.clone(),
        }),
        Effect::OpponentPlayedIllegalMove { id } => {
            Some(GameNotification::OpponentPlayedIllegalMove { id: *id })
        }
        Effect::WeSlashedOpponent { id, reward_coin } => {
            Some(GameNotification::WeSlashedOpponent {
                id: *id,
                reward_coin: reward_coin.clone(),
            })
        }
        Effect::OpponentSlashedUs { id } => Some(GameNotification::OpponentSlashedUs { id: *id }),
        Effect::OpponentSuccessfullyCheated {
            id,
            our_reward,
            reward_coin,
        } => Some(GameNotification::OpponentSuccessfullyCheated {
            id: *id,
            our_reward: our_reward.clone(),
            reward_coin: reward_coin.clone(),
        }),
        Effect::StaleChannelUnroll {
            our_reward,
            reward_coin,
        } => Some(GameNotification::StaleChannelUnroll {
            our_reward: our_reward.clone(),
            reward_coin: reward_coin.clone(),
        }),
        Effect::ChannelError { reason } => Some(GameNotification::ChannelError {
            reason: reason.clone(),
        }),
        Effect::GameError { id, reason } => Some(GameNotification::GameError {
            id: *id,
            reason: reason.clone(),
        }),
        Effect::ChannelCoinSpent => Some(GameNotification::ChannelCoinSpent),
        Effect::UnrollCoinSpent { reward_coin } => Some(GameNotification::UnrollCoinSpent {
            reward_coin: reward_coin.clone(),
        }),
        Effect::GameProposed {
            id,
            my_contribution,
            their_contribution,
        } => Some(GameNotification::GameProposed {
            id: *id,
            my_contribution: my_contribution.clone(),
            their_contribution: their_contribution.clone(),
        }),
        Effect::GameProposalAccepted { id } => {
            Some(GameNotification::GameProposalAccepted { id: *id })
        }
        Effect::GameProposalCancelled { id, reason } => {
            Some(GameNotification::GameProposalCancelled {
                id: *id,
                reason: reason.clone(),
            })
        }
        Effect::InsufficientBalance {
            id,
            our_balance_short,
            their_balance_short,
        } => Some(GameNotification::InsufficientBalance {
            id: *id,
            our_balance_short: *our_balance_short,
            their_balance_short: *their_balance_short,
        }),
        Effect::OpponentMoved {
            id,
            state_number,
            readable,
            mover_share,
        } => Some(GameNotification::OpponentMoved {
            id: *id,
            state_number: *state_number,
            readable: readable.clone(),
            mover_share: mover_share.clone(),
        }),
        Effect::GameMessage { id, readable } => Some(GameNotification::GameMessage {
            id: *id,
            readable: readable.clone(),
        }),
        Effect::ChannelCreated => Some(GameNotification::ChannelCreated),
        Effect::CleanShutdownStarted => Some(GameNotification::CleanShutdownStarted),
        Effect::CleanShutdownComplete { reward_coin } => {
            Some(GameNotification::CleanShutdownComplete {
                reward_coin: reward_coin.clone(),
            })
        }
        Effect::GoingOnChain { reason } => Some(GameNotification::GoingOnChain {
            reason: reason.clone(),
        }),
        _ => None,
    }
}

pub fn apply_effects(
    effects: Vec<Effect>,
    _allocator: &mut crate::common::types::AllocEncoder,
    system: &mut (impl crate::potato_handler::types::ToLocalUI
              + crate::potato_handler::types::PacketSender
              + crate::potato_handler::types::WalletSpendInterface
              + crate::potato_handler::types::BootstrapTowardWallet),
) -> Result<(), crate::common::types::Error> {
    for effect in effects.iter() {
        if let Some(notification) = effect_to_notification(effect) {
            system.notification(&notification)?;
            continue;
        }
        match effect {
            Effect::SendMessage(msg) => {
                system.send_message(msg)?;
            }
            Effect::SpendTransaction(bundle) => {
                system.spend_transaction_and_add_fee(bundle)?;
            }
            Effect::RegisterCoin {
                coin,
                timeout,
                name,
            } => {
                system.register_coin(coin, timeout, *name)?;
            }
            Effect::RequestPuzzleAndSolution(coin) => {
                system.request_puzzle_and_solution(coin)?;
            }
            Effect::ChannelPuzzleHash(ph) => {
                system.channel_puzzle_hash(ph)?;
            }
            Effect::ReceivedChannelOffer(bundle) => {
                system.received_channel_offer(bundle)?;
            }
            _ => unreachable!("all notification effects handled by effect_to_notification"),
        }
    }
    Ok(())
}
