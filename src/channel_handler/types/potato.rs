use crate::channel_handler::types::{LiveGame, ReadableMove};
use crate::channel_handler::ChannelCoinSpendInfo;
use crate::common::types::{Aggsig, Amount, GameID, Hash, Program, PuzzleHash};
use crate::referee::types::GameMoveDetails;
use serde::{Deserialize, Serialize};
use std::rc::Rc;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PotatoSignatures {
    // Half signed thing signing to the new state.
    pub my_channel_half_signature_peer: Aggsig,
    // Half signed thing allowing you to supercede an earlier state to this one.
    pub my_unroll_half_signature_peer: Aggsig,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MoveResult {
    pub signatures: PotatoSignatures,
    pub game_move: GameMoveDetails,
}

#[derive(Serialize, Deserialize)]
pub struct PotatoAcceptCachedData {
    pub game_id: GameID,
    pub puzzle_hash: PuzzleHash,
    pub live_game: LiveGame,
    pub at_stake_amount: Amount,
    pub our_share_amount: Amount,
}

impl std::fmt::Debug for PotatoAcceptCachedData {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        write!(formatter, "PotatoAcceptCachedData {{ game_id: {:?}, puzzle_hash: {:?}, live_game: .., at_stake_amount: {:?}, our_share_amount: {:?} }}", self.game_id, self.puzzle_hash, self.at_stake_amount, self.our_share_amount)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PotatoMoveCachedData {
    pub state_number: usize,
    pub game_id: GameID,
    pub puzzle_hash: PuzzleHash,
    pub match_puzzle_hash: PuzzleHash,
    pub move_data: ReadableMove,
    pub move_entropy: Hash,
    pub amount: Amount,
}

#[derive(Debug, Serialize, Deserialize)]
pub enum CachedPotatoRegenerateLastHop {
    PotatoCreatedGame(Vec<GameID>, Amount, Amount),
    PotatoAccept(Box<PotatoAcceptCachedData>),
    PotatoMoveHappening(Rc<PotatoMoveCachedData>),
}

pub struct ChannelHandlerMoveResult {
    pub spend_info: ChannelCoinSpendInfo,
    pub state_number: usize,
    pub readable_their_move: Rc<Program>,
    pub message: Vec<u8>,
    pub mover_share: Amount,
}
