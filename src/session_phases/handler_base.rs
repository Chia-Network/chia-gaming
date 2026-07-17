use std::collections::VecDeque;

use clvmr::NodePtr;

use serde::{Deserialize, Serialize};

use crate::channel_state::types::{ChannelCoinSpendInfo, ChannelEnv, ReadableMove};
use crate::channel_state::ChannelState;
use crate::common::standard_coin::puzzle_for_synthetic_public_key;
use crate::common::types::{
    Amount, CoinSpend, CoinString, Error, GameID, Hash, PuzzleHash, Spend, SpendBundle, Timeout,
};
use crate::session_phases::effects::GameStatusKind;
use crate::session_phases::effects::{CancelReason, Effect, GameNotification};
use crate::session_phases::types::{GameAction, PeerMessage, PotatoState};

pub enum UnrollOutcome {
    Preempted(SpendBundle),
    WaitForTimeout,
    Unrecoverable(String),
}

/// Determine whether an unroll can be preempted, needs to wait for timeout, or
/// is unrecoverable.  Used by SpendChannelCoinPhase.
pub fn classify_unroll(
    ch: &ChannelState,
    env: &mut ChannelEnv<'_>,
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
            let can_timeout = ch.get_historical_unroll_for_state(on_chain_state).is_ok();
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
    env: &mut ChannelEnv<'_>,
    ch: &ChannelState,
    channel_coin: &CoinString,
    saved: &ChannelCoinSpendInfo,
    name: &str,
) -> Result<SpendBundle, Error> {
    let channel_public_key = ch.get_aggregate_channel_public_key();
    let channel_coin_puzzle =
        puzzle_for_synthetic_public_key(env.allocator, &env.standard_puzzle, &channel_public_key)?;
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

/// Shared state and methods for handlers that hold a `ChannelState` and
/// park game actions while waiting for on-chain resolution (Phases 2a and 3).
#[derive(Serialize, Deserialize)]
pub struct ChannelStateBase {
    pub channel_state: Option<ChannelState>,
    pub game_action_queue: VecDeque<GameAction>,
    pub have_potato: PotatoState,
    pub channel_timeout: Timeout,
    pub unroll_timeout: Timeout,
}

impl ChannelStateBase {
    pub fn new(
        channel_state: Option<ChannelState>,
        game_action_queue: VecDeque<GameAction>,
        have_potato: PotatoState,
        channel_timeout: Timeout,
        unroll_timeout: Timeout,
    ) -> Self {
        ChannelStateBase {
            channel_state,
            game_action_queue,
            have_potato,
            channel_timeout,
            unroll_timeout,
        }
    }

    pub fn amount(&self) -> Amount {
        self.channel_state
            .as_ref()
            .map(|ch| ch.amount(true))
            .unwrap_or_default()
    }

    pub fn get_our_current_share(&self) -> Option<Amount> {
        self.channel_state
            .as_ref()
            .map(|ch| ch.my_out_of_game_balance())
    }

    pub fn get_their_current_share(&self) -> Option<Amount> {
        self.channel_state
            .as_ref()
            .map(|ch| ch.their_out_of_game_balance())
    }

    pub fn get_reward_puzzle_hash(
        &self,
        env: &mut ChannelEnv<'_>,
    ) -> Result<PuzzleHash, Error> {
        self.channel_state()?.get_reward_puzzle_hash(env)
    }

    pub fn get_game_state_id(
        &self,
        env: &mut ChannelEnv<'_>,
    ) -> Result<Option<Hash>, Error> {
        if let Some(ch) = self.channel_state.as_ref() {
            return ch.get_game_state_id(env).map(Some);
        }
        Ok(None)
    }

    pub fn has_potato(&self) -> bool {
        matches!(self.have_potato, PotatoState::Present)
    }

    pub fn channel_state(&self) -> Result<&ChannelState, Error> {
        self.channel_state
            .as_ref()
            .ok_or_else(|| Error::StrErr("no channel handler".to_string()))
    }

    pub fn channel_state_mut(&mut self) -> Result<&mut ChannelState, Error> {
        self.channel_state
            .as_mut()
            .ok_or_else(|| Error::StrErr("no channel handler".to_string()))
    }

    pub fn emit_failure_cleanup(&mut self) -> Vec<Effect> {
        let mut effects = Vec::new();
        if let Ok(ch) = self.channel_state_mut() {
            let cancelled_ids = ch.cancel_all_proposals();
            for id in cancelled_ids {
                effects.push(Effect::Notify(GameNotification::ProposalCancelled {
                    id,
                    reason: CancelReason::ChannelError,
                }));
            }
            let game_ids = ch.all_game_ids();
            for id in game_ids {
                effects.push(Effect::Notify(GameNotification::GameStatus {
                    id,
                    status: GameStatusKind::EndedError,
                    my_reward: None,
                    coin_id: None,
                    reason: Some("channel error".to_string()),
                    other_params: None,
                }));
            }
        }
        effects
    }

    /// Deserialize a peer message and handle `CleanShutdownComplete`;
    /// ignore everything else.
    pub fn received_message_passive(&self, msg: Vec<u8>) -> Result<Vec<Effect>, Error> {
        let msg_envelope: PeerMessage = bencodex::from_slice(&msg)
            .map_err(|e| Error::StrErr(format!("bencodex deserialize error: {e:?}")))?;

        if let PeerMessage::CleanShutdownComplete(coin_spend) = &msg_envelope {
            return Ok(vec![Effect::SpendTransaction(
                SpendBundle {
                    name: Some("Create unroll".to_string()),
                    spends: vec![coin_spend.clone()],
                },
                None,
            )]);
        }
        Ok(vec![])
    }

    pub fn park_move(&mut self, id: &GameID, readable: &ReadableMove, new_entropy: Hash) {
        self.game_action_queue
            .push_back(GameAction::Move(*id, readable.clone(), new_entropy));
    }

    pub fn park_accept_settlement(&mut self, id: &GameID) {
        self.game_action_queue
            .push_back(GameAction::AcceptSettlement(*id));
    }

    pub fn park_cheat(&mut self, game_id: &GameID, mover_share: Amount, entropy: Hash) {
        self.game_action_queue
            .push_back(GameAction::Cheat(*game_id, mover_share, entropy));
    }
}
