use clvmr::allocator::NodePtr;
use clvmr::{ChiaDialect, run_program};
use clvmr::NO_UNKNOWN_OPS;
use clvm_tools_rs::classic::clvm::sexp::proper_list;
use clvm_traits::ToClvm;

use crate::common::types::{AllocEncoder, Amount, Error, Hash, Aggsig, usize_from_atom, u64_from_atom, Node, IntoErr};
use crate::channel_handler::types::{ReadableMove, ReadableUX};

pub fn chia_dialect() -> ChiaDialect { ChiaDialect::new(NO_UNKNOWN_OPS) }

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
    pub fn their_driver_from_nodeptr(n: NodePtr) -> GameHandler {
        GameHandler::TheirTurnHandler(n)
    }
    pub fn my_driver_from_nodeptr(n: NodePtr) -> GameHandler {
        GameHandler::MyTurnHandler(n)
    }
    pub fn is_my_turn(&self) -> bool {
        matches!(self, GameHandler::MyTurnHandler(_))
    }

    pub fn get_my_turn_driver(&self) -> Result<NodePtr, Error> {
        if let GameHandler::MyTurnHandler(res) = self {
            Ok(*res)
        } else {
            Err(Error::StrErr("my turn called on a their turn driver".to_string()))
        }
    }

    pub fn get_their_turn_driver(&self) -> Result<NodePtr, Error> {
        if let GameHandler::TheirTurnHandler(res) = self {
            Ok(*res)
        } else {
            Err(Error::StrErr("my turn called on a their turn driver".to_string()))
        }
    }

    pub fn call_my_turn_driver(
        &self,
        allocator: &mut AllocEncoder,
        inputs: &MyTurnInputs
    ) -> Result<MyTurnResult, Error> {
        let driver_args =
            (inputs.readable_new_move.clone(),
             (inputs.amount.clone(),
              (Node(inputs.last_state.clone()),
               (inputs.entropy.clone(), ())))
            ).to_clvm(allocator).into_gen()?;

        let run_result = run_program(
            allocator.allocator(),
            &chia_dialect(),
            self.get_their_turn_driver()?,
            driver_args,
            0,
        ).into_gen()?.1;

            let pl =
            if let Some(pl) = proper_list(allocator.allocator(), run_result, true) {
                pl
            } else {
                return Err(Error::StrErr("bad result from game driver: not a list".to_string()));
            };

        if pl.len() != 8 {
            return Err(Error::StrErr("bad result from game driver: wrong length".to_string()));
        }

        let max_move_size =
            if let Some(mm) = usize_from_atom(allocator.allocator().atom(pl[4])) {
                mm
            } else {
                return Err(Error::StrErr("bad max move size".to_string()));
            };
        let mover_share =
            if let Some(ms) = u64_from_atom(allocator.allocator().atom(pl[5])) {
                Amount::new(ms)
            } else {
                return Err(Error::StrErr("bad share".to_string()));
            };
        let message_parser =
            if pl[7] == allocator.allocator().null() {
                None
            } else {
                Some(MessageHandler::from_nodeptr(pl[7]))
            };

        Ok(MyTurnResult {
            waiting_driver: GameHandler::their_driver_from_nodeptr(pl[6]),
            move_data: allocator.allocator().atom(pl[0]).to_vec(),
            validation_program: pl[1],
            validation_program_hash: Hash::from_slice(allocator.allocator().atom(pl[2])),
            state: pl[3],
            max_move_size,
            mover_share,
            message_parser
        })
}

    pub fn call_their_turn_driver(
        &self,
        allocator: &mut AllocEncoder,
        inputs: &TheirTurnInputs
    ) -> Result<TheirTurnResult, Error> {
        let driver_args =
            (inputs.amount.clone(),
             (Node(inputs.last_state.clone()),
              (inputs.new_move.clone(),
               (inputs.new_validation_info_hash.clone(),
                (inputs.new_max_move_size.clone(),
                 (inputs.new_mover_share.clone(), ())))))
            ).to_clvm(allocator).into_gen()?;

        let run_result = run_program(
            allocator.allocator(),
            &chia_dialect(),
            self.get_my_turn_driver()?,
            driver_args,
            0,
        ).into_gen()?.1;


        let pl =
            if let Some(pl) = proper_list(allocator.allocator(), run_result, true) {
                pl
            } else {
                return Err(Error::StrErr("bad result from game driver: not a list".to_string()));
            };

        if pl.is_empty() {
            return Err(Error::StrErr("bad result from game driver: wrong length".to_string()));
        }

        let move_type =
            if let Some(move_type) = usize_from_atom(allocator.allocator().atom(pl[0])) {
                move_type
            } else {
                return Err(Error::StrErr("bad move type".to_string()));
            };

        if move_type == 0 {
            if pl.len() == 4 {
                return Err(Error::StrErr("bad length".to_string()));
            }
            Ok(TheirTurnResult::MakeMove(GameHandler::my_driver_from_nodeptr(pl[2]), pl[1], allocator.allocator().atom(pl[3]).to_vec()))
        } else if move_type == 2 {
            let sig_bytes = allocator.allocator().atom(pl[3]).to_vec();
            Ok(TheirTurnResult::Slash(pl[1], Aggsig::from_slice(&sig_bytes)?))
        } else {
            Err(Error::StrErr("unknown move result type".to_string()))
        }
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
    pub fn from_nodeptr(n: NodePtr) -> Self { MessageHandler(n) }
    pub fn run(
        &self,
        allocator: &mut AllocEncoder,
        inputs: &MessageInputs
    ) -> Result<ReadableUX, Error> {
        todo!();
    }
}
