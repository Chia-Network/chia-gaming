use std::rc::Rc;

use serde::{Deserialize, Serialize};

use crate::utils::proper_list;
use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};
use clvmr::run_program;
use clvmr::NodePtr;

use log::debug;

use crate::channel_handler::types::{Evidence, ReadableMove, ValidationInfo, StateUpdateProgram};
use crate::common::types::{
    atom_from_clvm, chia_dialect, u64_from_atom, usize_from_atom, AllocEncoder, Amount, Error,
    Hash, IntoErr, Node, Program, ProgramRef,
};
use crate::referee::types::{GameMoveDetails, GameMoveStateInfo};

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

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum GameHandler {
    MyTurnHandler(ProgramRef),
    TheirTurnHandler(ProgramRef),
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for GameHandler {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        match self {
            GameHandler::MyTurnHandler(p) => p.to_clvm(encoder),
            GameHandler::TheirTurnHandler(p) => p.to_clvm(encoder),
        }
    }
}

pub struct MyTurnInputs<'a> {
    pub readable_new_move: ReadableMove,
    pub amount: Amount,
    pub last_move: &'a [u8],
    pub last_mover_share: Amount,
    pub last_max_move_size: usize,
    pub entropy: Hash,
}

#[derive(Debug)]
pub struct MyTurnResult {
    // Next player's turn game handler.
    pub waiting_driver: GameHandler,
    pub outgoing_move_state_update_program: StateUpdateProgram,
    pub outgoing_move_state_update_program_hash: Hash,
    pub incoming_move_state_update_program: StateUpdateProgram,
    pub incoming_move_state_update_program_hash: Hash,
    pub game_move: GameMoveStateInfo,
    pub message_parser: Option<MessageHandler>,
}

pub struct TheirTurnInputs<'a> {
    pub amount: Amount,
    pub last_state: NodePtr,

    /// Only needs a couple things from last move.
    pub last_move: &'a [u8],
    pub last_mover_share: Amount,

    /// New move is a full move details.
    pub new_move: GameMoveDetails,
}

fn get_their_turn_debug_flag(_: &TheirTurnInputs) -> bool {
    false
}

fn run_code(
    allocator: &mut AllocEncoder,
    code: NodePtr,
    env: NodePtr,
    _debug: bool,
) -> Result<NodePtr, Error> {
    run_program(allocator.allocator(), &chia_dialect(), code, env, 0)
        .into_gen()
        .map(|r| r.1)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TheirTurnMoveData {
    pub readable_move: ProgramRef,
    pub slash_evidence: Vec<Evidence>,
    pub mover_share: Amount,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TheirTurnResult {
    FinalMove(TheirTurnMoveData),
    MakeMove(GameHandler, Vec<u8>, TheirTurnMoveData),
    Slash(Evidence),
}

impl GameHandler {
    pub fn their_driver_from_nodeptr(
        allocator: &mut AllocEncoder,
        n: NodePtr,
    ) -> Result<GameHandler, Error> {
        Ok(GameHandler::TheirTurnHandler(
            Program::from_nodeptr(allocator, n)?.into(),
        ))
    }
    pub fn my_driver_from_nodeptr(
        allocator: &mut AllocEncoder,
        n: NodePtr,
    ) -> Result<GameHandler, Error> {
        Ok(GameHandler::MyTurnHandler(
            Program::from_nodeptr(allocator, n)?.into(),
        ))
    }
    pub fn to_nodeptr(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        match self {
            GameHandler::MyTurnHandler(n) => n.to_nodeptr(allocator),
            GameHandler::TheirTurnHandler(n) => n.to_nodeptr(allocator),
        }
    }
    pub fn is_my_turn(&self) -> bool {
        matches!(self, GameHandler::MyTurnHandler(_))
    }

    pub fn get_my_turn_driver(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        if let GameHandler::MyTurnHandler(res) = self {
            res.to_nodeptr(allocator)
        } else {
            Err(Error::StrErr(
                "my turn called on a their turn driver".to_string(),
            ))
        }
    }

    pub fn get_their_turn_driver(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        if let GameHandler::TheirTurnHandler(res) = self {
            res.to_nodeptr(allocator)
        } else {
            Err(Error::StrErr(
                "my turn called on a their turn driver".to_string(),
            ))
        }
    }

    pub fn call_my_turn_driver(
        &self,
        allocator: &mut AllocEncoder,
        inputs: &MyTurnInputs,
    ) -> Result<MyTurnResult, Error> {
        let driver_args = (
            inputs.readable_new_move.clone(),
            (
                inputs.amount.clone(),
                (
                    inputs.last_mover_share.clone(),
                    (inputs.last_max_move_size, (inputs.entropy.clone(), ())),
                ),
            ),
        )
            .to_clvm(allocator)
            .into_gen()?;

        let driver_node = self.get_my_turn_driver(allocator)?;
        let run_result = run_code(allocator, driver_node, driver_args, false);

        if run_result.is_err() {
            debug!("MY TURN HANDLER RETURNED ERROR {run_result:?}");
        }

        let run_result = run_result?;

        let pl = if let Some(pl) = proper_list(allocator.allocator(), run_result, true) {
            pl
        } else {
            return Err(Error::StrErr(
                "bad result from game driver: not a list".to_string(),
            ));
        };

        if pl.len() == 2 {
            let message_data = if pl.len() >= 2 {
                allocator.allocator().atom(pl[1]).to_vec()
            } else {
                vec![]
            };
            return Err(Error::GameMoveRejected(message_data));
        }

        if pl.len() < 8 {
            return Err(Error::StrErr(format!(
                "bad result from game driver: {}",
                Node(run_result).to_hex(allocator)?
            )));
        }

        let max_move_size =
            if let Some(mm) = atom_from_clvm(allocator, pl[3]).and_then(|a| usize_from_atom(&a)) {
                mm
            } else {
                return Err(Error::StrErr("bad max move size".to_string()));
            };
        let mover_share =
            if let Some(ms) = atom_from_clvm(allocator, pl[4]).and_then(|a| u64_from_atom(&a)) {
                Amount::new(ms)
            } else {
                return Err(Error::StrErr(format!(
                    "bad share {}",
                    Node(pl[4]).to_hex(allocator)?
                )));
            };
        debug!("MOVER_SHARE {mover_share:?}");
        let message_parser = if pl.len() <= 6 || pl[6] == allocator.allocator().nil() {
            None
        } else {
            Some(MessageHandler::from_nodeptr(allocator, pl[6])?)
        };

        let get_hash = |allocator: &mut AllocEncoder, loc: usize| {
            if let Some(h) = atom_from_clvm(allocator, pl[2]).map(|a| Hash::from_slice(&a)) {
                Ok(h)
            } else {
                return Err(Error::StrErr("bad hash".to_string()));
            }
        };

        let get_state_update_program = |allocator: &mut AllocEncoder, loc: usize| {
            let validation_prog = Rc::new(Program::from_nodeptr(allocator, pl[loc])?);
            Ok(StateUpdateProgram::new(allocator, validation_prog))
        };

        let outgoing_move_state_update_program_hash = get_hash(allocator, 2)?;
        let incoming_move_state_update_program_hash = get_hash(allocator, 4)?;
        let move_data = if let Some(m) = atom_from_clvm(allocator, pl[0]).map(|a| a.to_vec()) {
            m
        } else {
            return Err(Error::StrErr("bad move".to_string()));
        };

        let outgoing_move_state_update_program = get_state_update_program(allocator, 1)?;
        let incoming_move_state_update_program = get_state_update_program(allocator, 3)?;

        Ok(MyTurnResult {
            waiting_driver: GameHandler::their_driver_from_nodeptr(allocator, pl[5])?,
            outgoing_move_state_update_program,
            outgoing_move_state_update_program_hash,
            incoming_move_state_update_program,
            incoming_move_state_update_program_hash,
            game_move: GameMoveStateInfo {
                move_made: move_data,
                max_move_size,
                mover_share,
            },
            message_parser,
        })
    }

    pub fn call_their_turn_driver(
        &self,
        allocator: &mut AllocEncoder,
        inputs: &TheirTurnInputs,
    ) -> Result<TheirTurnResult, Error> {
        let driver_args = (
            inputs.amount.clone(),
            (
                Node(inputs.last_state),
                (
                    Node(
                        allocator
                            .encode_atom(clvm_traits::Atom::Borrowed(
                                &inputs.new_move.basic.move_made,
                            ))
                            .into_gen()?,
                    ),
                    (
                        inputs.new_move.validation_info_hash.clone(),
                        (
                            inputs.new_move.basic.max_move_size,
                            (inputs.new_move.basic.mover_share.clone(), ()),
                        ),
                    ),
                ),
            ),
        )
            .to_clvm(allocator)
            .into_gen()?;

        let driver_node = self.get_their_turn_driver(allocator)?;
        debug!("call their turn driver: {self:?}");
        debug!(
            "call their turn args {}",
            Node(driver_args).to_hex(allocator)?
        );

        let run_result = run_code(
            allocator,
            driver_node,
            driver_args,
            get_their_turn_debug_flag(inputs),
        )?;

        let pl = if let Some(pl) = proper_list(allocator.allocator(), run_result, true) {
            pl
        } else {
            return Err(Error::StrErr(
                "bad result from game driver: not a list".to_string(),
            ));
        };

        debug!("got move result len {}", pl.len());

        if pl.is_empty() {
            return Err(Error::StrErr(
                "bad result from game driver: wrong length".to_string(),
            ));
        }

        let move_type = if let Some(move_type) = usize_from_atom(&allocator.allocator().atom(pl[0]))
        {
            move_type
        } else {
            return Err(Error::StrErr("bad move type".to_string()));
        };

        if move_type == 0 {
            if pl.len() < 2 {
                return Err(Error::StrErr(format!(
                    "bad length for move result {}",
                    Node(run_result).to_hex(allocator)?
                )));
            }

            let decode_slash_evidence = |allocator: &mut AllocEncoder, index: Option<usize>| {
                let mut lst_nodeptr = index
                    .and_then(|i| proper_list(allocator.allocator(), pl[i], true))
                    .unwrap_or_default();
                lst_nodeptr.push(
                    allocator
                        .encode_atom(clvm_traits::Atom::Borrowed(&[]))
                        .into_gen()?,
                );
                let mut lst = Vec::new();
                for v in lst_nodeptr.into_iter() {
                    lst.push(Evidence::from_nodeptr(allocator, v)?);
                }
                Ok(lst)
            };

            let slash_evidence = if pl.len() >= 3 {
                decode_slash_evidence(allocator, Some(2))
            } else {
                decode_slash_evidence(allocator, None)
            };

            let their_turn_move_data = TheirTurnMoveData {
                readable_move: Program::from_nodeptr(allocator, pl[1])?.into(),
                mover_share: inputs.new_move.basic.mover_share.clone(),
                slash_evidence: slash_evidence?,
            };

            let message_data = if pl.len() >= 5 {
                allocator.allocator().atom(pl[4]).to_vec()
            } else {
                vec![]
            };

            if pl.len() < 5 {
                Ok(TheirTurnResult::FinalMove(their_turn_move_data))
            } else {
                Ok(TheirTurnResult::MakeMove(
                    GameHandler::my_driver_from_nodeptr(allocator, pl[3])?,
                    message_data,
                    their_turn_move_data,
                ))
            }
        } else if move_type == 2 {
            if pl.len() != 2 {
                return Err(Error::StrErr(format!(
                    "bad length for slash {}",
                    Node(run_result).to_hex(allocator)?
                )));
            }
            Ok(TheirTurnResult::Slash(Evidence::from_nodeptr(
                allocator, pl[1],
            )?))
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
    pub mover_share: Amount,
}

#[derive(Clone, Debug)]
pub struct MessageHandler(pub Program);

impl MessageHandler {
    pub fn from_nodeptr(allocator: &mut AllocEncoder, n: NodePtr) -> Result<Self, Error> {
        Ok(MessageHandler(Program::from_nodeptr(allocator, n)?))
    }
    pub fn run(
        &self,
        allocator: &mut AllocEncoder,
        inputs: &MessageInputs,
    ) -> Result<ReadableMove, Error> {
        let input_msg_atom = allocator
            .encode_atom(clvm_traits::Atom::Borrowed(&inputs.message))
            .into_gen()?;
        let args = (
            Node(input_msg_atom),
            (Node(inputs.state), (inputs.amount.clone(), ())),
        )
            .to_clvm(allocator)
            .into_gen()?;
        debug!("message parser program {:?}", self.0);
        debug!(
            "running message handler on args {}",
            Node(args).to_hex(allocator)?
        );
        let run_prog = self.0.to_nodeptr(allocator)?;
        let run_result = run_code(allocator, run_prog, args, false);

        if run_result.is_err() {
            todo!();
            debug!("MESSAGE PARSER RETURNED ERROR {run_result:?}");
        }

        ReadableMove::from_nodeptr(allocator, run_result?)
    }
}
