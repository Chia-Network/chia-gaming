use std::collections::VecDeque;

use serde::{Deserialize, Serialize};

use crate::channel_handler::types::{ChannelHandlerEnv, ReadableMove};
use crate::channel_handler::ChannelHandler;
use crate::common::types::{
    Amount, Error, GameID, Hash, PuzzleHash, SpendBundle, Timeout,
};
use crate::potato_handler::effects::{Effect, GameNotification};
use crate::potato_handler::types::{GameAction, PeerMessage, PotatoState};

/// Shared state and methods for handlers that hold a `ChannelHandler` and
/// park game actions while waiting for on-chain resolution (Phases 2a and 3).
#[derive(Serialize, Deserialize)]
pub struct ChannelHandlerBase {
    pub channel_handler: Option<ChannelHandler>,
    pub game_action_queue: VecDeque<GameAction>,
    pub have_potato: PotatoState,
    pub channel_timeout: Timeout,
    pub unroll_timeout: Timeout,

    #[serde(skip)]
    pub debug_lines: Vec<String>,
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
            debug_lines: Vec::new(),
        }
    }

    pub fn take_debug_lines(&mut self) -> Vec<String> {
        std::mem::take(&mut self.debug_lines)
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

    pub fn my_move_in_game(&self, game_id: &GameID) -> Option<bool> {
        self.channel_handler
            .as_ref()
            .and_then(|ch| ch.game_is_my_turn(game_id))
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
