use std::collections::BTreeMap;
use std::rc::Rc;

use serde::{Deserialize, Serialize};
use serde_json_any_key::*;

use crate::channel_handler::game_start_info::GameStartInfo;
use crate::channel_handler::types::{
    ChannelHandlerEnv, ChannelHandlerPrivateKeys, PotatoSignatures, ReadableMove,
};
use crate::common::types::{
    Aggsig, Amount, CoinSpend, CoinString, Error, GameID, GameType, Hash, Program, ProgramRef,
    PuzzleHash, SpendBundle, Timeout,
};
use crate::potato_handler::effects::{Effect, ResyncInfo};
use crate::potato_handler::handshake::{HandshakeB, HandshakeC, HandshakeD};
use crate::potato_handler::start::GameStart;
use crate::referee::types::GameMoveDetails;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WireProposeGame {
    pub start: GameStart,
    pub game_id: GameID,
    pub start_index: usize,
}

/// Async interface implemented by Peer to receive notifications about wallet
/// state.
pub trait BootstrapTowardWallet {
    /// Deliver the channel_puzzle_hash to the wallet.
    ///
    /// Only alice calls this.  Bob does not need this information because the
    /// information needed will be held at the level of the injected object instead.
    fn channel_puzzle_hash(&mut self, puzzle_hash: &PuzzleHash) -> Result<(), Error>;

    /// Tells the game layer that we received a partly funded offer to which we
    /// added our own coins and sent to the bootstrap wallet interface to use.
    /// We had previously received a partly funded spend bundle via the reply to
    /// channel_puzzle_hash,
    /// Should add a fee and try to spend.
    ///
    /// Asynchronously, channel_transaction_completion is delivered back to the
    /// potato handler.
    ///
    /// Only bob sends this, upon receiving message E, bob makes this call to
    /// inform the injected wallet bootstrap dependency that the spend bundle
    /// has been received (partly funded so far) and it is the job of the bootstrap
    /// wallet object injected dependency to finish funding this and actually
    /// spend it.
    fn received_channel_offer(&mut self, bundle: &SpendBundle) -> Result<(), Error>;
}

/// Spend wallet receiver
pub trait SpendWalletReceiver {
    fn coin_created(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error>;
    fn coin_spent(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error>;
    fn coin_timeout_reached(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error>;
    fn coin_puzzle_and_solution(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error>;
}

/// Unroll time wallet interface.
pub trait WalletSpendInterface {
    /// Enqueue an outbound transaction.
    fn spend_transaction_and_add_fee(&mut self, bundle: &SpendBundle) -> Result<(), Error>;

    /// Coin should report its lifecycle until it gets spent, then should be
    /// de-registered.
    fn register_coin(
        &mut self,
        coin_id: &CoinString,
        timeout: &Timeout,
        name: Option<&'static str>,
    ) -> Result<(), Error>;

    /// Request the puzzle and solution for a spent coin
    fn request_puzzle_and_solution(&mut self, coin_id: &CoinString) -> Result<(), Error>;
}

pub trait ToLocalUI {
    fn notification(
        &mut self,
        notification: &crate::potato_handler::effects::GameNotification,
    ) -> Result<(), Error>;

    fn log(&mut self, _line: &str) -> Result<(), Error> {
        Ok(())
    }
}

pub trait FromLocalUI {
    fn propose_game(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        game: &GameStart,
    ) -> Result<(Vec<GameID>, Vec<Effect>), Error>;

    fn accept_proposal(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
    ) -> Result<Vec<Effect>, Error>;

    fn cancel_proposal(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
    ) -> Result<Vec<Effect>, Error>;

    fn make_move(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        id: &GameID,
        readable: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<Vec<Effect>, Error>;

    fn accept_timeout(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        id: &GameID,
    ) -> Result<Vec<Effect>, Error>;

    fn shut_down(&mut self, env: &mut ChannelHandlerEnv<'_>) -> Result<Vec<Effect>, Error>;
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum BatchAction {
    ProposeGame(WireProposeGame),
    AcceptProposal(GameID),
    CancelProposal(GameID),
    Move(GameID, GameMoveDetails),
    #[serde(rename = "Accept")]
    AcceptTimeout(GameID, Amount),
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum PeerMessage {
    HandshakeA(HandshakeB),
    HandshakeB(HandshakeB),
    HandshakeC(HandshakeC),
    HandshakeD(HandshakeD),
    HandshakeE {
        bundle: SpendBundle,
        signatures: PotatoSignatures,
    },
    HandshakeF {
        bundle: SpendBundle,
    },

    Batch {
        actions: Vec<BatchAction>,
        signatures: PotatoSignatures,
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
                | PeerMessage::HandshakeE { .. }
                | PeerMessage::HandshakeF { .. }
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

#[derive(Serialize, Deserialize)]
pub enum GameAction {
    Move(GameID, ReadableMove, Hash),
    #[serde(rename = "Accept")]
    AcceptTimeout(GameID),
    CleanShutdown,
    SendPotato,
    QueuedProposal(Rc<GameStartInfo>, WireProposeGame),
    QueuedAcceptProposal(GameID),
    QueuedCancelProposal(GameID),
    Cheat(GameID, Amount, Hash),
}

impl std::fmt::Debug for GameAction {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        match self {
            GameAction::Move(gi, rm, h) => write!(formatter, "Move({gi:?},{rm:?},{h:?})"),
            GameAction::AcceptTimeout(gi) => write!(formatter, "AcceptTimeout({gi:?})"),
            GameAction::CleanShutdown => write!(formatter, "CleanShutdown"),
            GameAction::SendPotato => write!(formatter, "SendPotato"),
            GameAction::QueuedProposal(_, _) => write!(formatter, "QueuedProposal(..)"),
            GameAction::QueuedAcceptProposal(gi) => {
                write!(formatter, "QueuedAcceptProposal({gi:?})")
            }
            GameAction::QueuedCancelProposal(gi) => {
                write!(formatter, "QueuedCancelProposal({gi:?})")
            }
            GameAction::Cheat(gi, ms, _) => write!(formatter, "Cheat({gi:?},{ms:?})"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameFactory {
    pub program: Rc<Program>,
    /// The parser program used by the responder.
    /// The `program` field holds the proposal (make_proposal) program.
    #[serde(default)]
    pub parser_program: Option<Rc<Program>>,
}

#[derive(Serialize, Deserialize)]
pub struct PotatoHandlerInit {
    pub have_potato: bool,
    pub private_keys: ChannelHandlerPrivateKeys,
    #[serde(with = "any_key_map")]
    pub game_types: BTreeMap<GameType, GameFactory>,
    pub my_contribution: Amount,
    pub their_contribution: Amount,
    pub channel_timeout: Timeout,
    pub unroll_timeout: Timeout,
    pub reward_puzzle_hash: PuzzleHash,
}
