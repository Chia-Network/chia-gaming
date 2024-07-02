use clvmr::NodePtr;

use crate::common::types::{Aggsig, Amount, CoinID, CoinString, Error, GameID, Hash, Program, PuzzleHash, Timeout, TransactionBundle, PublicKey};
use crate::channel_handler::game_handler::GameHandler;
use crate::channel_handler::types::{PotatoSignatures, ReadableMove};

struct GameInfoMyTurn {
    id: GameID,
    their_turn_game_handler: GameHandler,
    validation_program: Program,
    validation_program_hash: Hash,
    state: NodePtr,
    move_made: Vec<u8>,
    max_move_size: usize,
    mover_share: Amount,
}

struct GameInfoTheirTurn {
    id: GameID,
    their_turn_game_handler: GameHandler,
    validation_program: Program,
    validation_program_hash: Hash,
    state: NodePtr,
    move_made: Vec<u8>,
    max_move_size: usize,
    mover_share: Amount,
}

/// Bootstrap wallet receiver
trait BootstrapWalletReceiver {
    /// Start puzzle hash retrieval.
    fn channel_puzzle_hash(&mut self, who: usize) -> Result<(), Error>;

    /// Out
    fn channel_offer(&mut self) -> Result<TransactionBundle, Error>;

    /// Out
    fn channel_transaction_completion(&mut self) -> Result<TransactionBundle, Error>;
}

/// Async device for querying the wallet and the block chain at bootstrap time.
trait WalletBootstrap {
    fn have_puzzle_hash(&mut self, ph: &PuzzleHash) -> Result<(), Error>;
    fn received_channel_offer(&mut self, bundle: &TransactionBundle) -> Result<(), Error>;
    fn received_channel_transaction_completion(&mut self, bundle: &TransactionBundle) -> Result<(), Error>;
}

/// Spend wallet receiver
trait SpendWalletReceiver {
    fn coin_created(&mut self, coin_id: &CoinID) -> Result<(), Error>;
    fn coin_spent(&mut self, coin_id: &CoinID) -> Result<(), Error>;
    fn coin_timeout_reached(&mut self, coin_id: &CoinID) -> Result<(), Error>;
}

/// Unroll time wallet interface.
trait WalletSpendInterface {
    fn spend_transaction_and_add_fee(&mut self, bundle: &TransactionBundle) -> Result<(), Error>;
    fn register_coin(&mut self, coin_id: &CoinID, timeout: &Timeout) -> Result<(), Error>;
}

struct GameType(Vec<u8>);

trait UIReceiver {
    fn opponent_moved(&mut self, id: &GameID, readable: ReadableMove) -> Result<(), Error>;
    fn game_message(&mut self, id: &GameID, readable: ReadableMove) -> Result<(), Error>;
    fn game_finished(&mut self, id: &GameID, my_share: Amount) -> Result<(), Error>;
    fn game_cancelled(&mut self, id: &GameID) -> Result<(), Error>;

    fn shutdown_complete(&mut self, reward_coin_string: &CoinString) -> Result<(), Error>;
    fn going_on_chain(&mut self) -> Result<(), Error>;
}

trait GameUI {
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
    ///
    fn start_games(&mut self, i_initiated: bool, games: &[(GameType, bool, NodePtr)]) -> Result<GameID, Error>;
    fn make_move(&mut self, id: GameID, readable: ReadableMove) -> Result<(), Error>;
    fn accept(&mut self, id: GameID) -> Result<(), Error>;
    fn shut_down(&mut self) -> Result<(), Error>;
}

pub enum PeerMessage {
    // Fixed in order sequence
    HandshakeA {
        parent: CoinID,
        public_keys: [PublicKey; 2],
        reward_puzzle_hash: PuzzleHash
    },
    HandshakeB {
        public_keys: [PublicKey; 2],
        reward_puzzle_hash: PuzzleHash
    },
    // HandshakeC and HandshakeD are Nil messages.

    /// Includes spend of launcher coin id.
    HandshakeE {
        bundle: TransactionBundle,
    },
    HandshakeF {
        bundle: TransactionBundle,
    },

    Nil(PotatoSignatures),
    Move(GameID, Vec<u8>, PotatoSignatures),
    Accept(GameID, PotatoSignatures),
    DataMessage(GameID, Vec<u8>),
    Shutdown(Aggsig),
    RequestPotato,
}

/// Handle potato in flight when I request potato:
///
/// Every time i send the potato, if i have stuff i want to do, then i also send
/// the request potato message directly after so I can be prompted to take another
/// thing off.
///
/// General workflow:
///
/// Whenever we receive the potato, check the work queues, notify channel handler,
/// then take the channel handler result with the potato and send it on.
///
/// If there is more work left, also send a receive potato message at that time.
///
/// Also do this when any queue becomes non-empty.
struct Peer {
}

/// Peer interface for high level opaque messages.
impl Peer {
    fn send_message(&mut self, msg: &PeerMessage) -> Result<Vec<u8>, Error> {
        todo!();
    }
    fn received_message(&mut self, msg: &[u8]) -> Result<PeerMessage, Error> {
        todo!();
    }
}
