use clvmr::allocator::{Allocator, NodePtr};

use crate::common::types::{AllocEncoder, Amount, Error, Hash, PuzzleHash, Aggsig};
use crate::channel_handler::types::{ReadableMove, ReadableUX};

// How to call the clvm program in this object:
//
// My turn driver takes (readable_new_move amount last_state last_move last_mover_share entropy) and returns
//       (waiting_driver move validation_program validation_program_hash state max_move_size mover_share
//       message_parser)
// Message parser takes (message amount state move mover_share) and returns error or readable_info
//
// their turn driver takes (amount last_state last_move last_mover_share 
//       new_move new_validation_info_hash new_max_move_size new_mover_share) and returns
//       (MAKE_MOVE moving_driver readable_info message) or
//       (SLASH evidence aggsig)

#[derive(Clone)]
pub enum GameHandler {
    MyTurnHandler(NodePtr),
    TheirTurnHandler(NodePtr)
}

pub struct MyTurnInputs<'a> {
    pub readable_new_move: ReadableMove,
    pub amount: Amount,
    pub last_state: NodePtr,
    pub last_move: &'a [u8],
    pub last_mover_share: Amount,
    pub entropy: Hash,
}

pub struct MyTurnResult {
    // Next player's turn game handler.
    pub waiting_driver: GameHandler,
    pub move_data: Vec<u8>,
    pub validation_program: NodePtr,
    pub validation_program_hash: Hash,
    pub state: NodePtr,
    pub max_move_size: usize,
    pub mover_share: Amount,
    pub message_parser: Option<MessageHandler>,
}

pub struct TheirTurnInputs<'a> {
    pub amount: Amount,
    pub last_state: NodePtr,
    pub last_move: &'a [u8],
    pub last_mover_share: Amount,
    pub new_move: &'a [u8],
    pub new_validation_info_hash: Hash,
    pub new_max_move_size: usize,
    pub new_mover_share: Amount,
}

pub enum TheirTurnResult {
    MakeMove(GameHandler, NodePtr, Vec<u8>),
    Slash(NodePtr, Aggsig)
}

impl GameHandler {
    pub fn is_my_turn(&self) -> bool {
        matches!(self, GameHandler::MyTurnHandler(_))
    }
    pub fn call_my_turn_driver(
        &self,
        allocator: &mut AllocEncoder,
        inputs: &MyTurnInputs
    ) -> Result<MyTurnResult, Error> {
        todo!();
    }

    pub fn call_their_turn_driver(
        &self,
        allocator: &mut AllocEncoder,
        inputs: &TheirTurnInputs
    ) -> Result<TheirTurnResult, Error> {
        todo!();
    }
}

pub struct MessageInputs {
    pub message: Vec<u8>,
    pub amount: Amount,
    pub state: NodePtr,
    pub move_data: Vec<u8>,
    pub mover_share: Amount
}

pub struct MessageHandler(pub NodePtr);

impl MessageHandler {
    pub fn run(
        &self,
        allocator: &mut AllocEncoder,
        inputs: &MessageInputs
    ) -> Result<ReadableUX, Error> {
        todo!();
    }
}
