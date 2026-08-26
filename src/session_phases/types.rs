use std::collections::BTreeMap;
use std::rc::Rc;

use serde::{Deserialize, Serialize};

use crate::channel_state::game_start_info::GameStartInfo;
use crate::channel_state::types::{
    ChannelEnv, ChannelPrivateKeys, ReadableMove, StateUpdateSignatures,
};
use crate::common::types::{
    Aggsig, Amount, CoinSpend, Error, GameID, GameType, Hash, Program, ProgramRef, PuzzleHash,
    Timeout,
};
use crate::referee::types::GameMoveDetails;
use crate::session_phases::effects::Effect;
use crate::session_phases::handshake::{
    HandshakePayloadB, HandshakePayloadC, HandshakePayloadD, HandshakePayloadE, HandshakePayloadF,
};
use crate::session_phases::proposal::GameProposal;

pub use crate::session_phases::wallet_traits::{
    ChannelFundingWallet, SpendWalletReceiver, WalletSpendInterface,
};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WireGameSpec {
    pub game_id: GameID,
    pub amount: Amount,
    pub player_a_contribution: Amount,
    pub player_b_contribution: Amount,
    pub player_a_goes_first: bool,
    pub initial_validation_program_hash: Hash,
    pub initial_move: Vec<u8>,
    pub initial_max_move_size: usize,
    pub initial_state: Program,
    pub initial_mover_share: Amount,
    pub my_turn_handler: Program,
    pub their_turn_handler: Program,
    pub initial_validation_program: Program,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WireProposalGroup {
    pub start: GameProposal,
    pub members: Vec<WireGameSpec>,
    /// Always the first member's game id (including singleton groups).
    pub group_id: GameID,
}

pub trait ToLocalUI {
    fn notification(
        &mut self,
        notification: &crate::session_phases::effects::GameNotification,
    ) -> Result<(), Error>;

    fn log(&mut self, _line: &str) -> Result<(), Error> {
        Ok(())
    }
}

pub trait FromLocalUI {
    fn propose_games(
        &mut self,
        env: &mut ChannelEnv<'_>,
        games: &[GameProposal],
    ) -> Result<(Vec<GameID>, Vec<Effect>), Error>;

    fn accept_proposal(
        &mut self,
        env: &mut ChannelEnv<'_>,
        game_id: &GameID,
    ) -> Result<Vec<Effect>, Error>;

    fn cancel_proposal(
        &mut self,
        env: &mut ChannelEnv<'_>,
        game_id: &GameID,
    ) -> Result<Vec<Effect>, Error>;

    fn make_move(
        &mut self,
        env: &mut ChannelEnv<'_>,
        id: &GameID,
        readable: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<Vec<Effect>, Error>;

    fn accept_settlement(
        &mut self,
        env: &mut ChannelEnv<'_>,
        id: &GameID,
    ) -> Result<Vec<Effect>, Error>;

    fn shut_down(&mut self, env: &mut ChannelEnv<'_>) -> Result<Vec<Effect>, Error>;
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum BatchAction {
    ProposeGroup(WireProposalGroup),
    AcceptProposal(GameID),
    CancelProposal(GameID),
    Move(GameID, GameMoveDetails),
    #[serde(rename = "AcceptSettlement")]
    AcceptSettlement(GameID, Amount),
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum PeerMessage {
    HandshakeA(HandshakePayloadB),
    HandshakeB(HandshakePayloadB),
    HandshakeC(HandshakePayloadC),
    HandshakeD(HandshakePayloadD),
    HandshakeE(HandshakePayloadE),
    HandshakeF(HandshakePayloadF),

    Batch {
        actions: Vec<BatchAction>,
        signatures: StateUpdateSignatures,
        clean_shutdown: Option<Box<(Aggsig, ProgramRef)>>,
    },
    CleanShutdownComplete(CoinSpend),
    RequestPotato(()),
    Message(GameID, Vec<u8>),
}

impl PeerMessage {
    pub fn is_handshake(&self) -> bool {
        matches!(
            self,
            PeerMessage::HandshakeA(_)
                | PeerMessage::HandshakeB(_)
                | PeerMessage::HandshakeC(_)
                | PeerMessage::HandshakeD(_)
                | PeerMessage::HandshakeE(_)
                | PeerMessage::HandshakeF(_)
        )
    }
}

pub trait PacketSender {
    fn send_message(&mut self, msg: &PeerMessage) -> Result<(), Error>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PotatoState {
    Absent,
    Requested,
    Present,
}

#[derive(Clone, Serialize, Deserialize)]
pub enum GameAction {
    Move(GameID, ReadableMove, Hash),
    #[serde(rename = "AcceptSettlement")]
    AcceptSettlement(GameID),
    CleanShutdown,
    QueuedProposalGroup(Vec<Rc<GameStartInfo>>, WireProposalGroup),
    QueuedAcceptProposal(GameID),
    QueuedCancelProposal(GameID),
    QueuedCancelProposalSilently(GameID),
    Cheat(GameID, Amount, Hash),
    #[cfg(test)]
    ForcedSelfAccept(GameID),
}

pub(crate) fn validate_new_move_action<'a>(
    game_id: &GameID,
    authority: Option<bool>,
    queued_actions: impl IntoIterator<Item = &'a GameAction>,
    pending: bool,
) -> Result<(), Error> {
    let has_queued_move = queued_actions
        .into_iter()
        .any(|action| matches!(action, GameAction::Move(queued_id, ..) if queued_id == game_id));
    game_assert!(
        authority == Some(true),
        "make_move called when game authority does not give us the turn"
    );
    game_assert!(
        !has_queued_move,
        "make_move called while a move for this game is already queued"
    );
    game_assert!(
        !pending,
        "make_move called while a move for this game is pending"
    );
    Ok(())
}

impl std::fmt::Debug for GameAction {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        match self {
            GameAction::Move(gi, rm, h) => write!(formatter, "Move({gi:?},{rm:?},{h:?})"),
            GameAction::AcceptSettlement(gi) => write!(formatter, "AcceptSettlement({gi:?})"),
            GameAction::CleanShutdown => write!(formatter, "CleanShutdown"),
            GameAction::QueuedProposalGroup(_, _) => write!(formatter, "QueuedProposalGroup(..)"),
            GameAction::QueuedAcceptProposal(gi) => {
                write!(formatter, "QueuedAcceptProposal({gi:?})")
            }
            GameAction::QueuedCancelProposal(gi) => {
                write!(formatter, "QueuedCancelProposal({gi:?})")
            }
            GameAction::QueuedCancelProposalSilently(gi) => {
                write!(formatter, "QueuedCancelProposalSilently({gi:?})")
            }
            GameAction::Cheat(gi, ms, _) => write!(formatter, "Cheat({gi:?},{ms:?})"),
            #[cfg(test)]
            GameAction::ForcedSelfAccept(gi) => write!(formatter, "ForcedSelfAccept({gi:?})"),
        }
    }
}

#[cfg(test)]
mod move_authority_tests {
    use super::*;

    fn queued_move(game_id: GameID) -> GameAction {
        GameAction::Move(
            game_id,
            ReadableMove::from_program(Rc::new(Program::from_bytes(&[0x80]))),
            Hash::default(),
        )
    }

    #[test]
    #[should_panic(expected = "already queued")]
    fn second_move_for_same_game_while_queued_fails_loudly() {
        let game_id = GameID(7);
        let queue = [queued_move(game_id)];
        let _ = validate_new_move_action(&game_id, Some(true), &queue, false);
    }

    #[test]
    #[should_panic(expected = "pending")]
    fn second_move_for_same_game_while_pending_fails_loudly() {
        let _ = validate_new_move_action(&GameID(7), Some(true), &[], true);
    }

    #[test]
    #[should_panic(expected = "does not give us the turn")]
    fn move_when_game_authority_says_their_turn_fails_loudly() {
        let _ = validate_new_move_action(&GameID(7), Some(false), &[], false);
    }
}

#[derive(Serialize, Deserialize)]
pub struct OffChainPhaseInit {
    pub have_potato: bool,
    pub private_keys: ChannelPrivateKeys,
    pub game_types: BTreeMap<GameType, ProgramRef>,
    pub my_contribution: Amount,
    pub their_contribution: Amount,
    pub channel_timeout: Timeout,
    pub unroll_timeout: Timeout,
    pub reward_puzzle_hash: PuzzleHash,
}
