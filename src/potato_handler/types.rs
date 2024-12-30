use std::rc::Rc;
use rand::Rng;
use clvmr::NodePtr;

use crate::channel_handler::types::{
    ChannelHandlerEnv, FlatGameStartInfo, GameStartInfo, MoveResult, PotatoSignatures, ReadableMove,
};
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinString, Error, GameID, Hash, Program, PublicKey, PuzzleHash, Spend, SpendBundle,
    Timeout,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GameStart {
    pub game_type: GameType,
    pub timeout: Timeout,
    pub amount: Amount,
    pub my_contribution: Amount,
    pub my_turn: bool,
    pub parameters: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireGameStart {
    pub game_ids: Vec<GameID>,
    pub start: GameStart,
}

#[derive(Debug, Clone)]
pub struct GameStartQueueEntry;

#[derive(Debug, Clone)]
pub struct MyGameStartQueueEntry {
    pub my_games: Vec<GameStartInfo>,
    pub their_games: Vec<GameStartInfo>,
}

/// Async interface for messaging out of the game layer toward the wallet.
///
/// For this and its companion if instances are left in the documentation which
/// refer to the potato handler combining spend bundles, that work has been decided
/// to not take place in the potato handler.  The injected wallet bootstrap
/// dependency must be stateful enough that it can cope with receiving a partly
/// funded offer spend bundle and fully fund it if needed.
pub trait BootstrapTowardGame<
    G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender,
    R: Rng,
>
{
    /// Gives a partly signed offer to the wallet bootstrap.
    ///
    /// Intended use: channel_puzzle_hash delivers the desired puzzle hash and this
    /// is the reply which delivers a transaction bundle for an already spent
    /// transaction creating the channel coin.
    ///
    /// The launcher program is passed a list of conditions and returns that list
    /// of conditions with an announcement including their shatree as an
    /// announcement.
    ///
    /// The launcher coin is implicit in the returned transaction bundle in that
    /// we can compute its coin string from this information.
    ///
    /// The launcher coin must be a specific program such as the singleton
    /// launcher.
    ///
    /// The launcher coin targets the channel puzzle with the right amount.
    ///
    /// "Half funded" transaction in a spend bundle to which spends will be
    /// added that fully fund it, condition on the given announcement named
    /// above by the launcher coin.
    ///
    /// The launcher coin will be in here so the other guy can pick it out and
    /// make the assumption that it is the launcher coin.  It is identifiable by
    /// its puzzle hash.
    ///
    /// We forward this spend bundle over a potato message and the peer passes
    /// it to the other guy's injected wallet dependency via received_channel_offer
    /// below.
    ///
    /// channel offer should deliver both the launcher coin id and the partly
    /// funded spend bundle.  Alice absolutely needs the channel coin id in some
    /// way from here.
    ///
    /// Only alice sends this spend bundle in message E, but only after receiving
    /// message D.
    fn channel_offer<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        bundle: SpendBundle,
    ) -> Result<(), Error>
    where
        R: 'a,
        G: 'a;

    /// Gives the fully signed offer to the wallet bootstrap.
    /// Causes bob to send this spend bundle down the wire to the other peer.
    ///
    /// When these spend bundles are combined and deduplicated, together a
    /// fully spendble transaction will result, to which fee might need to be
    /// added.
    ///
    /// Alice sends this to the wallet interface via received_channel_transaction
    /// completion to finish this phase of execution.
    ///
    /// Bob receives this callback from the wallet interface with the fully funded
    /// but not fee adjusted spend bundle on bob's side.  It is given back to alice
    /// and must contain appropriate spends to generate the launcher coin
    /// announcement.
    ///
    /// This is sent back to alice as message F.
    ///
    /// Both alice and bob, upon knowing the full channel coin id, use the more
    /// general wallet interface to register for notifications of the channel coin.
    fn channel_transaction_completion<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        bundle: &SpendBundle,
    ) -> Result<(), Error>
    where
        R: 'a,
        G: 'a;
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

    /// Bob has sent this to us via the potato interface and it is given here to
    /// the wallet injected dependency to actually spend.  Alice must add a fee
    /// if needed.
    ///
    /// Both alice and bob, upon knowing the full channel coin id, use the more
    /// general wallet interface to register for notifications of the channel coin.
    fn received_channel_transaction_completion(
        &mut self,
        bundle: &SpendBundle,
    ) -> Result<(), Error>;
}

/// Spend wallet receiver
pub trait SpendWalletReceiver<
    G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender,
    R: Rng,
>
{
    fn coin_created<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        coin_id: &CoinString,
    ) -> Result<(), Error>
    where
        G: 'a,
        R: 'a;
    fn coin_spent<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        coin_id: &CoinString,
    ) -> Result<(), Error>
    where
        G: 'a,
        R: 'a;
    fn coin_timeout_reached<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        coin_id: &CoinString,
    ) -> Result<(), Error>
    where
        G: 'a,
        R: 'a;
}

/// Unroll time wallet interface.
pub trait WalletSpendInterface {
    /// Enqueue an outbound transaction.
    fn spend_transaction_and_add_fee(
        &mut self,
        bundle: &Spend,
        parent: Option<&CoinString>,
    ) -> Result<(), Error>;
    /// Coin should report its lifecycle until it gets spent, then should be
    /// de-registered.
    fn register_coin(&mut self, coin_id: &CoinString, timeout: &Timeout) -> Result<(), Error>;
}

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq, PartialOrd, Ord)]
pub struct GameType(pub Vec<u8>);

pub trait ToLocalUI {
    fn self_move(&mut self, _id: &GameID, _readable: &[u8]) -> Result<(), Error> {
        Ok(())
    }
    fn opponent_moved(
        &mut self,
        allocator: &mut AllocEncoder,
        id: &GameID,
        readable: ReadableMove,
    ) -> Result<(), Error>;
    fn raw_game_message(&mut self, _id: &GameID, _readable: &[u8]) -> Result<(), Error> {
        Ok(())
    }
    fn game_message(
        &mut self,
        allocator: &mut AllocEncoder,
        id: &GameID,
        readable: ReadableMove,
    ) -> Result<(), Error>;
    fn game_finished(&mut self, id: &GameID, my_share: Amount) -> Result<(), Error>;
    fn game_cancelled(&mut self, id: &GameID) -> Result<(), Error>;

    fn shutdown_complete(&mut self, reward_coin_string: &CoinString) -> Result<(), Error>;
    fn going_on_chain(&mut self) -> Result<(), Error>;
}

pub trait FromLocalUI<
    G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender,
    R: Rng,
>
{
    /// Start games requires queueing so that we handle them one at a time only
    /// when the previous start game.
    ///
    /// Queue of games we want to start that are also waiting after this.
    ///
    /// We must request the potato if not had.
    ///
    /// General flow:
    ///
    /// Have queues of games we're starting and other side is starting.
    fn start_games<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        i_initiated: bool,
        game: &GameStart,
    ) -> Result<Vec<GameID>, Error>
    where
        G: 'a,
        R: 'a;

    fn make_move<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        id: &GameID,
        readable: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<(), Error>
    where
        G: 'a,
        R: 'a;

    fn accept<'a>(&mut self, penv: &mut dyn PeerEnv<'a, G, R>, id: &GameID) -> Result<(), Error>
    where
        G: 'a,
        R: 'a;

    fn shut_down<'a>(
        &mut self,
        penv: &mut dyn PeerEnv<'a, G, R>,
        condition: NodePtr,
    ) -> Result<(), Error>
    where
        G: 'a,
        R: 'a;
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct HandshakeB {
    pub channel_public_key: PublicKey,
    pub unroll_public_key: PublicKey,
    pub reward_puzzle_hash: PuzzleHash,
    pub referee_puzzle_hash: PuzzleHash,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct HandshakeA {
    pub parent: CoinString,
    pub simple: HandshakeB,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum PeerMessage {
    // Fixed in order sequence
    HandshakeA(HandshakeA),
    HandshakeB(HandshakeB),

    /// Includes spend of launcher coin id.
    HandshakeE {
        bundle: SpendBundle,
    },
    HandshakeF {
        bundle: SpendBundle,
    },

    Nil(PotatoSignatures),
    Move(GameID, MoveResult),
    Message(GameID, Vec<u8>),
    Accept(GameID, Amount, PotatoSignatures),
    Shutdown(Aggsig, Rc<Program>),
    RequestPotato(()),
    StartGames(PotatoSignatures, Vec<FlatGameStartInfo>),
}

#[derive(Debug, Clone)]
pub struct HandshakeStepInfo {
    #[allow(dead_code)]
    pub first_player_hs_info: HandshakeA,
    #[allow(dead_code)]
    pub second_player_hs_info: HandshakeB,
}

#[derive(Debug, Clone)]
pub struct HandshakeStepWithSpend {
    #[allow(dead_code)]
    pub info: HandshakeStepInfo,
    #[allow(dead_code)]
    pub spend: SpendBundle,
}

#[derive(Debug)]
pub enum HandshakeState {
    StepA,
    StepB,
    StepC(CoinString, Box<HandshakeA>),
    StepD(Box<HandshakeStepInfo>),
    StepE(Box<HandshakeStepInfo>),
    PostStepE(Box<HandshakeStepInfo>),
    StepF(Box<HandshakeStepInfo>),
    PostStepF(Box<HandshakeStepInfo>),
    Finished(Box<HandshakeStepWithSpend>),
    WaitingForShutdown(CoinString, CoinString),
    Completed,
}

pub trait PacketSender {
    fn send_message(&mut self, msg: &PeerMessage) -> Result<(), Error>;
}

pub trait PeerEnv<'inputs, G, R>
where
    G: ToLocalUI + WalletSpendInterface + BootstrapTowardWallet + PacketSender,
    R: Rng,
{
    fn env(&mut self) -> (&mut ChannelHandlerEnv<'inputs, R>, &mut G);
}

pub enum PotatoState {
    Absent,
    Requested,
    Present,
}

pub enum GameAction {
    Move(GameID, ReadableMove, Hash),
    Accept(GameID),
    Shutdown(NodePtr),
}
