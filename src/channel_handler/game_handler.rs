use serde::{Deserialize, Serialize};

#[cfg(test)]
use clvm_tools_rs::classic::clvm_tools::stages::stage_0::DefaultProgramRunner;
#[cfg(test)]
use clvm_tools_rs::compiler::compiler::DefaultCompilerOpts;
use std::rc::Rc;

use clvm_tools_rs::classic::clvm::sexp::proper_list;
use clvm_tools_rs::classic::clvm_tools::binutils::disassemble;
#[cfg(test)]
use clvm_tools_rs::compiler::clvm::{convert_from_clvm_rs, convert_to_clvm_rs, run};
#[cfg(test)]
use clvm_tools_rs::compiler::comptypes::CompilerOpts;
#[cfg(test)]
use clvm_tools_rs::compiler::srcloc::Srcloc;
use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};
use clvmr::allocator::NodePtr;
use clvmr::run_program;

use log::debug;

use crate::channel_handler::types::{Evidence, ReadableMove, ValidationInfo, ValidationProgram};
use crate::common::types::{
    atom_from_clvm, chia_dialect, u64_from_atom, usize_from_atom, Aggsig, AllocEncoder, Amount,
    Error, Hash, IntoErr, Node, Program,
};
use crate::referee::{GameMoveDetails, GameMoveStateInfo};

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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub enum GameHandler {
    MyTurnHandler(Rc<Program>),
    TheirTurnHandler(Rc<Program>),
}

impl ToClvm<NodePtr> for GameHandler {
    fn to_clvm(
        &self,
        encoder: &mut impl ClvmEncoder<Node = NodePtr>,
    ) -> Result<NodePtr, ToClvmError> {
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
    #[cfg(test)]
    pub run_debug: bool,
}

#[cfg(test)]
fn get_my_turn_debug_flag(my_turn: &MyTurnInputs) -> bool {
    my_turn.run_debug
}
#[cfg(not(test))]
fn get_my_turn_debug_flag(_: &MyTurnInputs) -> bool {
    false
}

#[derive(Debug)]
pub struct MyTurnResult {
    // Next player's turn game handler.
    pub waiting_driver: GameHandler,
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

    #[cfg(test)]
    pub run_debug: bool,
}

#[cfg(test)]
fn get_their_turn_debug_flag(their_turn: &TheirTurnInputs) -> bool {
    their_turn.run_debug
}
#[cfg(not(test))]
fn get_their_turn_debug_flag(_: &TheirTurnInputs) -> bool {
    false
}

#[cfg(test)]
fn run_code(
    allocator: &mut AllocEncoder,
    code: NodePtr,
    env: NodePtr,
    debug: bool,
) -> Result<NodePtr, Error> {
    if debug {
        let loc = Srcloc::start("game_handler");
        let converted_code =
            convert_from_clvm_rs(allocator.allocator(), loc.clone(), code).into_gen()?;

        let converted_env = convert_from_clvm_rs(allocator.allocator(), loc, env).into_gen()?;

        let opts = Rc::new(DefaultCompilerOpts::new("game_handler"));

        let result = run(
            allocator.allocator(),
            Rc::new(DefaultProgramRunner::new()),
            opts.prim_map(),
            converted_code,
            converted_env,
            None,
            None,
        )
        .into_gen()?;

        convert_to_clvm_rs(allocator.allocator(), result).into_gen()
    } else {
        debug!(
            "running handler code with args {}",
            disassemble(allocator.allocator(), env, None)
        );
        run_program(allocator.allocator(), &chia_dialect(), code, env, 0)
            .into_gen()
            .map(|r| r.1)
    }
}

#[cfg(not(test))]
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

#[derive(Debug, Clone)]
pub enum TheirTurnResult {
    FinalMove(NodePtr),
    MakeMove(NodePtr, GameHandler, Vec<u8>),
    Slash(Evidence, Box<Aggsig>),
}

impl GameHandler {
    pub fn their_driver_from_nodeptr(
        allocator: &mut AllocEncoder,
        n: NodePtr,
    ) -> Result<GameHandler, Error> {
        Ok(GameHandler::TheirTurnHandler(Rc::new(
            Program::from_nodeptr(allocator, n)?,
        )))
    }
    pub fn my_driver_from_nodeptr(
        allocator: &mut AllocEncoder,
        n: NodePtr,
    ) -> Result<GameHandler, Error> {
        Ok(GameHandler::MyTurnHandler(Rc::new(Program::from_nodeptr(
            allocator, n,
        )?)))
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

        debug!(
            "driver_args {}",
            disassemble(allocator.allocator(), driver_args, None)
        );

        let driver_node = self.get_my_turn_driver(allocator)?;
        let run_result = run_code(
            allocator,
            driver_node,
            driver_args,
            get_my_turn_debug_flag(inputs),
        )?;

        debug!(
            "my turn driver result {}",
            disassemble(allocator.allocator(), run_result, None)
        );

        let pl = if let Some(pl) = proper_list(allocator.allocator(), run_result, true) {
            pl
        } else {
            return Err(Error::StrErr(
                "bad result from game driver: not a list".to_string(),
            ));
        };

        if pl.len() != 8 {
            return Err(Error::StrErr(format!(
                "bad result from game driver: {}",
                disassemble(allocator.allocator(), run_result, None)
            )));
        }

        let max_move_size =
            if let Some(mm) = atom_from_clvm(allocator, pl[4]).and_then(usize_from_atom) {
                mm
            } else {
                return Err(Error::StrErr("bad max move size".to_string()));
            };
        let mover_share = if let Some(ms) = atom_from_clvm(allocator, pl[5]).and_then(u64_from_atom)
        {
            Amount::new(ms)
        } else {
            return Err(Error::StrErr(format!(
                "bad share {}",
                disassemble(allocator.allocator(), pl[5], None)
            )));
        };
        let message_parser = if pl[7] == allocator.allocator().null() {
            None
        } else {
            Some(MessageHandler::from_nodeptr(allocator, pl[7])?)
        };
        let validation_program_hash =
            if let Some(h) = atom_from_clvm(allocator, pl[2]).map(Hash::from_slice) {
                h
            } else {
                return Err(Error::StrErr("bad hash".to_string()));
            };
        let move_data = if let Some(m) = atom_from_clvm(allocator, pl[0]).map(|a| a.to_vec()) {
            m
        } else {
            return Err(Error::StrErr("bad move".to_string()));
        };

        let validation_program = ValidationProgram::new(allocator, pl[1]);
        let state = Rc::new(Program::from_nodeptr(allocator, pl[3])?);
        Ok(MyTurnResult {
            waiting_driver: GameHandler::their_driver_from_nodeptr(allocator, pl[6])?,
            validation_program,
            validation_program_hash: validation_program_hash.clone(),
            state,
            game_move: GameMoveDetails {
                basic: GameMoveStateInfo {
                    move_made: move_data,
                    max_move_size,
                    mover_share,
                },
                validation_info_hash: ValidationInfo::new_from_validation_program_hash_and_state(
                    allocator,
                    validation_program_hash,
                    pl[3],
                )
                .hash()
                .clone(),
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
                            .encode_atom(&inputs.new_move.basic.move_made)
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

        if pl.is_empty() {
            return Err(Error::StrErr(
                "bad result from game driver: wrong length".to_string(),
            ));
        }

        let move_type = if let Some(move_type) = usize_from_atom(allocator.allocator().atom(pl[0]))
        {
            move_type
        } else {
            return Err(Error::StrErr("bad move type".to_string()));
        };

        if move_type == 0 {
            if pl.len() < 2 {
                Err(Error::StrErr(format!(
                    "bad length for move result {}",
                    disassemble(allocator.allocator(), run_result, None)
                )))
            } else if pl.len() < 3 {
                debug!(
                    "final move with data {}",
                    disassemble(allocator.allocator(), pl[1], None)
                );
                Ok(TheirTurnResult::FinalMove(pl[1]))
            } else {
                let message_data = if pl.len() == 4 {
                    allocator.allocator().atom(pl[3]).to_vec()
                } else {
                    vec![]
                };
                Ok(TheirTurnResult::MakeMove(
                    pl[1],
                    GameHandler::my_driver_from_nodeptr(allocator, pl[2])?,
                    message_data,
                ))
            }
        } else if move_type == 2 {
            if pl.len() != 3 {
                return Err(Error::StrErr(format!(
                    "bad length for slash {}",
                    disassemble(allocator.allocator(), run_result, None)
                )));
            }
            let sig_bytes = allocator.allocator().atom(pl[2]).to_vec();
            Ok(TheirTurnResult::Slash(
                Evidence::from_nodeptr(pl[1]),
                Box::new(Aggsig::from_slice(&sig_bytes)?),
            ))
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
        let input_msg_atom = allocator.encode_atom(&inputs.message).into_gen()?;
        let args = (
            Node(input_msg_atom),
            (Node(inputs.state), (inputs.amount.clone(), ())),
        )
            .to_clvm(allocator)
            .into_gen()?;
        eprintln!(
            "running message handler on args {}",
            disassemble(allocator.allocator(), args, None)
        );
        let run_prog = self.0.to_nodeptr(allocator)?;
        let run_result = run_code(allocator, run_prog, args, false)?;

        ReadableMove::from_nodeptr(allocator, run_result)
    }
}
