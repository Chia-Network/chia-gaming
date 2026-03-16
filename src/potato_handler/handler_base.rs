use std::collections::VecDeque;

use clvmr::NodePtr;

use serde::{Deserialize, Serialize};

use crate::channel_handler::types::{ChannelCoinSpendInfo, ChannelHandlerEnv, ReadableMove};
use crate::channel_handler::ChannelHandler;
use crate::common::standard_coin::puzzle_for_synthetic_public_key;
use crate::common::types::{
    Amount, CoinSpend, CoinString, Error, GameID, Hash, PuzzleHash, Spend, SpendBundle, Timeout,
};
use crate::potato_handler::effects::{Effect, GameNotification};
use crate::potato_handler::types::{GameAction, PeerMessage, PotatoState};

pub enum UnrollOutcome {
    Preempted(SpendBundle),
    WaitForTimeout,
    Unrecoverable(String),
}

/// Determine whether an unroll can be preempted, needs to wait for timeout, or
/// is unrecoverable.  Shared by ShutdownHandler and UnrollWatchHandler.
pub fn classify_unroll(
    ch: &ChannelHandler,
    env: &mut ChannelHandlerEnv<'_>,
    conditions_nodeptr: NodePtr,
    unroll_coin: &CoinString,
    on_chain_state: usize,
) -> Result<UnrollOutcome, Error> {
    let spend_result = ch.channel_coin_spent(env, false, conditions_nodeptr);

    match spend_result {
        Ok(result) if !result.timeout => {
            let bundle = SpendBundle {
                name: Some("preempt unroll".to_string()),
                spends: vec![CoinSpend {
                    bundle: result.transaction,
                    coin: unroll_coin.clone(),
                }],
            };
            Ok(UnrollOutcome::Preempted(bundle))
        }
        Ok(_) => Ok(UnrollOutcome::WaitForTimeout),
        Err(e) => {
            let can_timeout = ch.get_unroll_for_state(on_chain_state).is_ok();
            if can_timeout {
                Ok(UnrollOutcome::WaitForTimeout)
            } else {
                Ok(UnrollOutcome::Unrecoverable(format!(
                    "cannot preempt ({e:?}) and no stored state for timeout at {on_chain_state}"
                )))
            }
        }
    }
}

/// Build a SpendBundle that spends the channel coin into an unroll coin using
/// a previously cached `ChannelCoinSpendInfo`.
pub fn build_channel_to_unroll_bundle(
    env: &mut ChannelHandlerEnv<'_>,
    ch: &ChannelHandler,
    channel_coin: &CoinString,
    saved: &ChannelCoinSpendInfo,
    name: &str,
) -> Result<SpendBundle, Error> {
    let channel_public_key = ch.get_aggregate_channel_public_key();
    let channel_coin_puzzle = puzzle_for_synthetic_public_key(
        env.allocator,
        &env.standard_puzzle,
        &channel_public_key,
    )?;
    Ok(SpendBundle {
        name: Some(name.to_string()),
        spends: vec![CoinSpend {
            coin: channel_coin.clone(),
            bundle: Spend {
                solution: saved.solution.clone().into(),
                signature: saved.aggsig.clone(),
                puzzle: channel_coin_puzzle,
            },
        }],
    })
}

/// Shared state and methods for handlers that hold a `ChannelHandler` and
/// park game actions while waiting for on-chain resolution (Phases 2a and 3).
#[derive(Serialize, Deserialize)]
pub struct ChannelHandlerBase {
    pub channel_handler: Option<ChannelHandler>,
    pub game_action_queue: VecDeque<GameAction>,
    pub have_potato: PotatoState,
    pub channel_timeout: Timeout,
    pub unroll_timeout: Timeout,
}

impl ChannelHandlerBase {
    pub fn new(
        channel_handler: Option<ChannelHandler>,
        game_action_queue: VecDeque<GameAction>,
        have_potato: PotatoState,
        channel_timeout: Timeout,
        unroll_timeout: Timeout,
    ) -> Self {
        ChannelHandlerBase {
            channel_handler,
            game_action_queue,
            have_potato,
            channel_timeout,
            unroll_timeout,
        }
    }

    pub fn amount(&self) -> Amount {
        self.channel_handler
            .as_ref()
            .map(|ch| ch.amount(true))
            .unwrap_or_default()
    }

    pub fn get_our_current_share(&self) -> Option<Amount> {
        self.channel_handler
            .as_ref()
            .map(|ch| ch.my_out_of_game_balance())
    }

    pub fn get_their_current_share(&self) -> Option<Amount> {
        self.channel_handler
            .as_ref()
            .map(|ch| ch.their_out_of_game_balance())
    }

    pub fn get_reward_puzzle_hash(
        &self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<PuzzleHash, Error> {
        self.channel_handler()?.get_reward_puzzle_hash(env)
    }

    pub fn get_game_state_id(
        &self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<Option<Hash>, Error> {
        if let Some(ch) = self.channel_handler.as_ref() {
            return ch.get_game_state_id(env).map(Some);
        }
        Ok(None)
    }

    pub fn has_potato(&self) -> bool {
        matches!(self.have_potato, PotatoState::Present)
    }

    pub fn channel_handler(&self) -> Result<&ChannelHandler, Error> {
        self.channel_handler
            .as_ref()
            .ok_or_else(|| Error::StrErr("no channel handler".to_string()))
    }

    pub fn channel_handler_mut(&mut self) -> Result<&mut ChannelHandler, Error> {
        self.channel_handler
            .as_mut()
            .ok_or_else(|| Error::StrErr("no channel handler".to_string()))
    }

    pub fn emit_failure_cleanup(&mut self) -> Vec<Effect> {
        let mut effects = Vec::new();
        if let Ok(ch) = self.channel_handler_mut() {
            let cancelled_ids = ch.cancel_all_proposals();
            for id in cancelled_ids {
                effects.push(Effect::Notify(GameNotification::GameProposalCancelled {
                    id,
                    reason: "channel error".to_string(),
                }));
            }
            let game_ids = ch.all_game_ids();
            for id in game_ids {
                effects.push(Effect::Notify(GameNotification::GameError {
                    id,
                    reason: "channel error".to_string(),
                }));
            }
        }
        effects
    }

    /// Deserialize a peer message and handle `CleanShutdownComplete`;
    /// ignore everything else.
    pub fn received_message_passive(&self, msg: Vec<u8>) -> Result<Vec<Effect>, Error> {
        let doc = bson::Document::from_reader(&mut msg.as_slice())
            .map_err(|e| Error::StrErr(format!("bson parse error: {e:?}")))?;
        let msg_envelope: PeerMessage = bson::from_bson(bson::Bson::Document(doc))
            .map_err(|e| Error::StrErr(format!("bson deserialize error: {e:?}")))?;

        if let PeerMessage::CleanShutdownComplete(coin_spend) = &msg_envelope {
            return Ok(vec![Effect::SpendTransaction(SpendBundle {
                name: Some("Create unroll".to_string()),
                spends: vec![coin_spend.clone()],
            })]);
        }
        Ok(vec![])
    }

    pub fn park_move(
        &mut self,
        id: &GameID,
        readable: &ReadableMove,
        new_entropy: Hash,
    ) {
        self.game_action_queue.push_back(GameAction::Move(
            *id,
            readable.clone(),
            new_entropy,
        ));
    }

    pub fn park_accept_timeout(&mut self, id: &GameID) {
        self.game_action_queue
            .push_back(GameAction::AcceptTimeout(*id));
    }

    pub fn park_cheat(&mut self, game_id: &GameID, mover_share: Amount, entropy: Hash) {
        self.game_action_queue
            .push_back(GameAction::Cheat(*game_id, mover_share, entropy));
    }
}
