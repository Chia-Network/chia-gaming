use std::rc::Rc;

use serde::{Deserialize, Serialize};

use crate::utils::proper_list;
use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};
use clvmr::run_program;
use clvmr::NodePtr;

use crate::channel_handler::types::{Evidence, ReadableMove, StateUpdateProgram};
use crate::common::types::{
    atom_from_clvm, chia_dialect, u64_from_atom, usize_from_atom, AllocEncoder, Amount, Error,
    Hash, IntoErr, Node, Program, ProgramRef, MAX_BLOCK_COST_CLVM,
};
use crate::referee::types::GameMoveDetails;

// How to call the clvm program in this object:
//
// My turn handler takes (local_move amount state mover_share entropy) and returns
//       (label move outgoing_validator outgoing_validator_hash incoming_validator
//        incoming_validator_hash max_move_size mover_share their_turn_handler message_parser)
// Message parser takes (message state amount) and returns readable_info or raises
//
// Their turn handler takes (amount pre_state state move validation_info_hash mover_share) and returns
//       (readable_move evidence_list next_handler message_optional)

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

pub struct MyTurnInputs {
    pub readable_new_move: ReadableMove,
    pub entropy: Hash,

    pub amount: Amount,
    pub last_mover_share: Amount,
    pub state: ProgramRef,
}

#[derive(Clone, Debug)]
pub struct MyTurnResult {
    // Next player's turn game handler.
    pub name: String,
    pub move_bytes: Vec<u8>,
    pub outgoing_move_state_update_program: StateUpdateProgram,
    pub outgoing_move_state_update_program_hash: Hash,
    pub incoming_move_state_update_program: StateUpdateProgram,
    pub incoming_move_state_update_program_hash: Hash,
    pub max_move_size: usize,
    pub mover_share: Amount,
    pub waiting_handler: Option<GameHandler>,
    pub message_parser: Option<MessageHandler>,
}

pub struct TheirTurnInputs<'a> {
    pub amount: Amount,
    pub pre_state: NodePtr,
    pub state: NodePtr,

    pub last_move: &'a [u8],
    pub last_mover_share: Amount,

    pub new_move: GameMoveDetails,
}

fn run_code(allocator: &mut AllocEncoder, code: NodePtr, env: NodePtr) -> Result<NodePtr, Error> {
    run_program(
        allocator.allocator(),
        &chia_dialect(),
        code,
        env,
        MAX_BLOCK_COST_CLVM,
    )
    .into_gen()
    .map(|r| r.1)
}

fn get_state_update_program(
    allocator: &mut AllocEncoder,
    name: &str,
    suffix: &str,
    pl: &[NodePtr],
    loc: usize,
) -> Result<StateUpdateProgram, Error> {
    let final_name = format!("{} {}", name, suffix);
    let validation_prog = Rc::new(Program::from_nodeptr(allocator, pl[loc])?);
    Ok(StateUpdateProgram::new(
        allocator,
        &final_name,
        validation_prog,
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TheirTurnResult {
    pub readable_move: ProgramRef,
    pub slash_evidence: Vec<Evidence>,
    pub mover_share: Amount,
    pub next_handler: Option<GameHandler>,
    pub message: Vec<u8>,
}

impl GameHandler {
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
    pub fn is_my_turn(&self) -> bool {
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
                "their turn called on a my turn handler".to_string(),
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
                    inputs.state.clone(),
                    (
                        inputs.last_mover_share.clone(),
                        (inputs.entropy.clone(), ()),
                    ),
                ),
            ),
        )
            .to_clvm(allocator)
            .into_gen()?;

        let handler_node = self.get_my_turn_handler(allocator)?;
        let run_result = run_code(allocator, handler_node, handler_args);

        let run_result = run_result?;

        let pl = if let Some(pl) = proper_list(allocator.allocator(), run_result, true) {
            pl
        } else {
            return Err(Error::StrErr(
                "bad result from game handler: not a list".to_string(),
            ));
        };

        if pl.len() == 2 {
            let message_data = allocator.allocator().atom(pl[1]).to_vec();
            return Err(Error::GameMoveRejected(message_data));
        }

        if pl.len() < 9 {
            return Err(Error::StrErr(format!(
                "bad result from game handler: {}",
                Node(run_result).to_hex(allocator)?
            )));
        }

        let name_atom = &atom_from_clvm(allocator, pl[0]).unwrap_or_default();
        let name = std::str::from_utf8(name_atom)
            .map_err(|e| Error::StrErr(format!("game handler name is not valid UTF-8: {e}")))?;
        let max_move_size =
            if let Some(mm) = atom_from_clvm(allocator, pl[6]).and_then(|a| usize_from_atom(&a)) {
                mm
            } else {
                return Err(Error::StrErr("bad max move size".to_string()));
            };
        let mover_share =
            if let Some(ms) = atom_from_clvm(allocator, pl[7]).and_then(|a| u64_from_atom(&a)) {
                Amount::new(ms)
            } else {
                return Err(Error::StrErr(format!(
                    "bad share {}",
                    Node(pl[7]).to_hex(allocator)?
                )));
            };
        let message_parser = if pl.len() <= 9 || pl[9] == allocator.allocator().nil() {
            None
        } else {
            Some(MessageHandler::from_nodeptr(allocator, pl[9])?)
        };

        let get_hash = |allocator: &mut AllocEncoder, loc: usize| {
            if let Some(a) = atom_from_clvm(allocator, pl[loc]) {
                Hash::from_slice(&a)
            } else {
                Err(Error::StrErr("bad hash".to_string()))
            }
        };

        let outgoing_move_state_update_program_hash = get_hash(allocator, 3)?;
        let incoming_move_state_update_program_hash = get_hash(allocator, 5)?;
        let move_data = if let Some(m) = atom_from_clvm(allocator, pl[1]).map(|a| a.to_vec()) {
            m
        } else {
            let run_result_prog = Program::from_nodeptr(allocator, run_result)?;
            return Err(Error::StrErr(format!(
                "bad move in my turn handler result {:?}",
                run_result_prog
            )));
        };

        let outgoing_move_state_update_program =
            get_state_update_program(allocator, name, "my turn", &pl, 2)?;
        let incoming_move_state_update_program =
            get_state_update_program(allocator, name, "their_turn", &pl, 4)?;

        Ok(MyTurnResult {
            name: name.to_string(),
            waiting_handler: if pl[8] == allocator.allocator().nil() {
                None
            } else {
                Some(GameHandler::their_handler_from_nodeptr(allocator, pl[8])?)
            },
            outgoing_move_state_update_program: outgoing_move_state_update_program,
            outgoing_move_state_update_program_hash,
            incoming_move_state_update_program: incoming_move_state_update_program,
            incoming_move_state_update_program_hash,
            move_bytes: move_data,
            mover_share,
            max_move_size,
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
                Node(inputs.pre_state),
                (
                    Node(inputs.state),
                    (
                        Node(
                            allocator
                                .encode_atom(clvm_traits::Atom::Borrowed(
                                    &inputs.new_move.basic.move_made,
                                ))
                                .into_gen()?,
                        ),
                        (
                            inputs.new_move.validation_program_hash.clone(),
                            (inputs.new_move.basic.mover_share.clone(), ()),
                        ),
                    ),
                ),
            ),
        )
            .to_clvm(allocator)
            .into_gen()?;

        let handler_node = self.get_their_turn_handler(allocator)?;

        let run_result_e = run_code(allocator, handler_node, handler_args);

        let run_result = match run_result_e {
            Ok(v) => v,
            Err(Error::ClvmErr(e)) => {
                let failing_hex = Node(e.node_ptr()).to_hex(allocator)?;
                let failing_prefix = &failing_hex[..failing_hex.len().min(96)];
                return Err(Error::StrErr(format!(
                    "their turn handler failed: error={e:?} move_len={} move_hex={} pre_state_len={} state_len={} pre_state={:?} state={:?} node_len={} node_prefix={}{}",
                    inputs.new_move.basic.move_made.len(),
                    hex::encode(&inputs.new_move.basic.move_made),
                    proper_list(allocator.allocator(), inputs.pre_state, true)
                        .map(|v| v.len())
                        .unwrap_or(0),
                    proper_list(allocator.allocator(), inputs.state, true)
                        .map(|v| v.len())
                        .unwrap_or(0),
                    Program::from_nodeptr(allocator, inputs.pre_state)?,
                    Program::from_nodeptr(allocator, inputs.state)?,
                    failing_hex.len(),
                    failing_prefix,
                    if failing_hex.len() > failing_prefix.len() {
                        "..."
                    } else {
                        ""
                    }
                )));
            }
            Err(e) => {
                return Err(Error::StrErr(format!(
                    "their turn handler failed: move_len={} move_hex={} pre_state_len={} state_len={} pre_state={:?} state={:?} error={e:?}",
                    inputs.new_move.basic.move_made.len(),
                    hex::encode(&inputs.new_move.basic.move_made),
                    proper_list(allocator.allocator(), inputs.pre_state, true)
                        .map(|v| v.len())
                        .unwrap_or(0),
                    proper_list(allocator.allocator(), inputs.state, true)
                        .map(|v| v.len())
                        .unwrap_or(0),
                    Program::from_nodeptr(allocator, inputs.pre_state)?,
                    Program::from_nodeptr(allocator, inputs.state)?,
                )));
            }
        };

        let pl = if let Some(pl) = proper_list(allocator.allocator(), run_result, true) {
            pl
        } else {
            return Err(Error::StrErr(format!(
                "bad result from game handler: not a list {:?}",
                Program::from_nodeptr(allocator, run_result)?
            )));
        };

        if pl.len() < 2 {
            return Err(Error::StrErr(format!(
                "bad length for move result {}",
                Node(run_result).to_hex(allocator)?
            )));
        }

        let decode_slash_evidence = |allocator: &mut AllocEncoder| {
            let mut lst = Vec::new();
            let lst_nodeptr = proper_list(allocator.allocator(), pl[1], true).unwrap_or_default();

            for v in lst_nodeptr.into_iter() {
                lst.push(Evidence::from_nodeptr(allocator, v)?);
            }
            Ok(lst)
        };

        let slash_evidence: Vec<Evidence> = decode_slash_evidence(allocator)?;

        let message = if pl.len() >= 4 {
            allocator.allocator().atom(pl[3]).to_vec()
        } else {
            vec![]
        };

        let next_handler = if pl.len() >= 3 && pl[2] != allocator.allocator().nil() {
            Some(GameHandler::my_handler_from_nodeptr(allocator, pl[2])?)
        } else {
            None
        };

        Ok(TheirTurnResult {
            readable_move: Program::from_nodeptr(allocator, pl[0])?.into(),
            mover_share: inputs.new_move.basic.mover_share.clone(),
            slash_evidence,
            next_handler,
            message,
        })
    }
}

pub struct MessageInputs {
    pub message: Vec<u8>,
    pub state: ProgramRef,
    pub amount: Amount,
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
            (inputs.state.clone(), (inputs.amount.clone(), ())),
        )
            .to_clvm(allocator)
            .into_gen()?;
        let run_prog = self.0.to_nodeptr(allocator)?;
        let run_result = run_code(allocator, run_prog, args);

        let run_output = run_result
            .map_err(|e| Error::StrErr(format!("message parser returned error: {e:?}")))?;

        ReadableMove::from_nodeptr(allocator, run_output)
    }
}
