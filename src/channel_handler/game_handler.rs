use std::rc::Rc;

use serde::{Deserialize, Serialize};

use crate::utils::proper_list;
use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};
use clvmr::run_program;
use clvmr::NodePtr;

use log::debug;

use crate::channel_handler::types::{Evidence, ReadableMove, ValidationInfo, ValidationProgram};
use crate::channel_handler::v1;
use crate::common::types::{
    atom_from_clvm, chia_dialect, u64_from_atom, usize_from_atom, AllocEncoder, Amount, Error,
    Hash, IntoErr, Node, Program, ProgramRef,
};
use crate::referee::types::{GameMoveDetails, GameMoveStateInfo};

// How to call the clvm program in this object:
//
// My turn handler takes (readable_new_move amount last_state last_move last_mover_share entropy) and returns
//       (waiting_handler move validation_program validation_program_hash state max_move_size mover_share
//       message_parser)
// Message parser takes (message amount state move mover_share) and returns error or readable_info
//
// their turn handler takes (amount last_state last_move last_mover_share
//       new_move new_validation_info_hash new_max_move_size new_mover_share) and returns
//       (readable_info evidence_list moving_handler message_optional) or
//       (SLASH evidence)

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum GameHandler {
    MyTurnHandler(ProgramRef),
    TheirTurnHandler(ProgramRef),
    HandlerV1(v1::game_handler::GameHandler),
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for GameHandler {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        match self {
            GameHandler::MyTurnHandler(p) => p.to_clvm(encoder),
            GameHandler::TheirTurnHandler(p) => p.to_clvm(encoder),
            GameHandler::HandlerV1(g) => g.to_clvm(encoder),
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

#[derive(Debug, Serialize, Deserialize)]
pub struct MyTurnResult {
    // Next player's turn game handler.
    pub waiting_handler: GameHandler,
    pub validation_program: ValidationProgram,
    pub validation_program_hash: Hash,
    pub state: Rc<Program>,
    pub game_move: GameMoveDetails,
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
    pub fn v1(&self) -> v1::game_handler::GameHandler {
        if let GameHandler::HandlerV1(g) = self {
            return g.clone();
        }
        todo!();
    }

    pub fn their_handler_from_nodeptr(
        allocator: &mut AllocEncoder,
        n: NodePtr,
    ) -> Result<GameHandler, Error> {
        Ok(GameHandler::TheirTurnHandler(
            Program::from_nodeptr(allocator, n)?.into(),
        ))
    }
    pub fn my_handler_from_nodeptr(
        allocator: &mut AllocEncoder,
        n: NodePtr,
    ) -> Result<GameHandler, Error> {
        Ok(GameHandler::MyTurnHandler(
            Program::from_nodeptr(allocator, n)?.into(),
        ))
    }
    pub fn to_nodeptr(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        self.to_clvm(allocator).into_gen()
    }
    pub fn is_my_turn(&self) -> bool {
        if let GameHandler::HandlerV1(g) = self {
            return g.is_my_turn();
        }
        matches!(self, GameHandler::MyTurnHandler(_))
    }

    pub fn get_my_turn_handler(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        if let GameHandler::MyTurnHandler(res) = self {
            res.to_nodeptr(allocator)
        } else {
            Err(Error::StrErr(
                "my turn called on a their turn handler".to_string(),
            ))
        }
    }

    pub fn get_their_turn_handler(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        if let GameHandler::TheirTurnHandler(res) = self {
            res.to_nodeptr(allocator)
        } else {
            Err(Error::StrErr(
                "my turn called on a their turn handler".to_string(),
            ))
        }
    }

    pub fn call_my_turn_handler(
        &self,
        allocator: &mut AllocEncoder,
        inputs: &MyTurnInputs,
    ) -> Result<MyTurnResult, Error> {
        let handler_args = (
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

        let handler_node = self.get_my_turn_handler(allocator)?;
        let run_result = run_code(allocator, handler_node, handler_args, false)?;

        let pl = if let Some(pl) = proper_list(allocator.allocator(), run_result, true) {
            pl
        } else {
            return Err(Error::StrErr(
                "bad result from game handler: not a list".to_string(),
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

        if pl.len() < 7 {
            return Err(Error::StrErr(format!(
                "bad result from game handler: {}",
                Node(run_result).to_hex(allocator)?
            )));
        }

        let max_move_size =
            if let Some(mm) = atom_from_clvm(allocator, pl[4]).and_then(|a| usize_from_atom(&a)) {
                mm
            } else {
                return Err(Error::StrErr("bad max move size".to_string()));
            };
        let mover_share =
            if let Some(ms) = atom_from_clvm(allocator, pl[5]).and_then(|a| u64_from_atom(&a)) {
                Amount::new(ms)
            } else {
                return Err(Error::StrErr(format!(
                    "bad share {}",
                    Node(pl[5]).to_hex(allocator)?
                )));
            };
        debug!("MOVER_SHARE {mover_share:?}");
        let message_parser = if pl.len() <= 7 || pl[7] == allocator.allocator().nil() {
            None
        } else {
            Some(MessageHandler::from_nodeptr(allocator, pl[7])?)
        };
        let validation_program_hash =
            if let Some(h) = atom_from_clvm(allocator, pl[2]).map(|a| Hash::from_slice(&a)) {
                h
            } else {
                return Err(Error::StrErr("bad hash".to_string()));
            };
        let move_data = if let Some(m) = atom_from_clvm(allocator, pl[0]).map(|a| a.to_vec()) {
            m
        } else {
            return Err(Error::StrErr("bad move".to_string()));
        };

        let validation_prog = Rc::new(Program::from_nodeptr(allocator, pl[1])?);
        let validation_program = ValidationProgram::new(allocator, validation_prog);
        let state = Rc::new(Program::from_nodeptr(allocator, pl[3])?);
        Ok(MyTurnResult {
            waiting_handler: GameHandler::their_handler_from_nodeptr(allocator, pl[6])?,
            validation_program,
            validation_program_hash: validation_program_hash.clone(),
            state: state.clone(),
            game_move: GameMoveDetails {
                basic: GameMoveStateInfo {
                    move_made: move_data,
                    max_move_size,
                    mover_share,
                },
                validation_info_hash: ValidationInfo::new_from_validation_program_hash_and_state(
                    allocator,
                    validation_program_hash,
                    state,
                )
                .hash()
                .clone(),
            },
            message_parser,
        })
    }

    pub fn call_their_turn_handler(
        &self,
        allocator: &mut AllocEncoder,
        inputs: &TheirTurnInputs,
    ) -> Result<TheirTurnResult, Error> {
        let handler_args = (
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

        let handler_node = self.get_their_turn_handler(allocator)?;
        debug!("call their turn handler: {self:?}");
        debug!(
            "call their turn args {}",
            Node(handler_args).to_hex(allocator)?
        );

        let run_result = run_code(
            allocator,
            handler_node,
            handler_args,
            get_their_turn_debug_flag(inputs),
        )?;

        let pl = if let Some(pl) = proper_list(allocator.allocator(), run_result, true) {
            pl
        } else {
            return Err(Error::StrErr(
                "bad result from game handler: not a list".to_string(),
            ));
        };

        debug!("got move result len {}", pl.len());

        if pl.is_empty() {
            return Err(Error::StrErr(
                "bad result from game handler: wrong length".to_string(),
            ));
        }

        let mut offset = 0usize;
        let move_type = atom_from_clvm(allocator, pl[0]).and_then(|a| usize_from_atom(&a));
        if let Some(move_type) = move_type {
            if move_type == 2 {
                if pl.len() != 2 {
                    return Err(Error::StrErr(format!(
                        "bad length for slash {}",
                        Node(run_result).to_hex(allocator)?
                    )));
                }
                return Ok(TheirTurnResult::Slash(Evidence::from_nodeptr(
                    allocator, pl[1],
                )?));
            }
            if move_type == 0 {
                // Legacy MAKE_MOVE tag.
                offset = 1;
            }
        }

        if pl.len() < offset + 2 {
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

        let slash_evidence = if pl.len() >= offset + 2 {
            decode_slash_evidence(allocator, Some(offset + 1))
        } else {
            decode_slash_evidence(allocator, None)
        };

        let their_turn_move_data = TheirTurnMoveData {
            readable_move: Program::from_nodeptr(allocator, pl[offset])?.into(),
            mover_share: inputs.new_move.basic.mover_share.clone(),
            slash_evidence: slash_evidence?,
        };

        let message_data = if pl.len() >= offset + 4 {
            allocator.allocator().atom(pl[offset + 3]).to_vec()
        } else {
            vec![]
        };

        if pl.len() < offset + 3 || pl[offset + 2] == allocator.allocator().nil() {
            Ok(TheirTurnResult::FinalMove(their_turn_move_data))
        } else {
            Ok(TheirTurnResult::MakeMove(
                GameHandler::my_handler_from_nodeptr(allocator, pl[offset + 2])?,
                message_data,
                their_turn_move_data,
            ))
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

#[derive(Clone, Debug, Serialize, Deserialize)]
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
        eprintln!(
            "running message handler on args {}",
            Node(args).to_hex(allocator)?
        );
        let run_prog = self.0.to_nodeptr(allocator)?;
        let run_result = run_code(allocator, run_prog, args, false)?;

        ReadableMove::from_nodeptr(allocator, run_result)
    }
}
