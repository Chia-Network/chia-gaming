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
    pub sender_contribution: Amount,
    pub receiver_contribution: Amount,
    pub sender_goes_first: bool,
    pub initial_validation_program_hash: Hash,
    pub initial_move: Vec<u8>,
    pub initial_max_move_size: usize,
    pub initial_state: Program,
    pub initial_mover_share: Amount,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WireProposalGroup {
    pub start: GameProposal,
    pub members: Vec<WireGameSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<GameID>,
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
    SendPotato,
    QueuedProposalGroup(Vec<Rc<GameStartInfo>>, WireProposalGroup),
    QueuedAcceptProposal(GameID),
    QueuedCancelProposal(GameID),
    QueuedCancelProposalSilently(GameID),
    Cheat(GameID, Amount, Hash),
    #[cfg(test)]
    ForcedSelfAccept(GameID),
}

impl std::fmt::Debug for GameAction {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        match self {
            GameAction::Move(gi, rm, h) => write!(formatter, "Move({gi:?},{rm:?},{h:?})"),
            GameAction::AcceptSettlement(gi) => write!(formatter, "AcceptSettlement({gi:?})"),
            GameAction::CleanShutdown => write!(formatter, "CleanShutdown"),
            GameAction::SendPotato => write!(formatter, "SendPotato"),
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameFactory {
    pub program: Option<Rc<Program>>,
}

#[derive(Serialize, Deserialize)]
pub struct OffChainPhaseInit {
    pub have_potato: bool,
    pub private_keys: ChannelPrivateKeys,
    pub game_types: BTreeMap<GameType, GameFactory>,
    pub my_contribution: Amount,
    pub their_contribution: Amount,
    pub channel_timeout: Timeout,
    pub unroll_timeout: Timeout,
    pub reward_puzzle_hash: PuzzleHash,
}
