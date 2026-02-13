use std::rc::Rc;

use serde::{Deserialize, Serialize};

use crate::utils::proper_list;
use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};
use clvmr::reduction::EvalErr;
use clvmr::run_program;
use clvmr::NodePtr;

use log::debug;

use crate::channel_handler::game_handler;
use crate::channel_handler::game_handler::{TheirTurnMoveData, TheirTurnResult};
use crate::channel_handler::types::{Evidence, ReadableMove, StateUpdateProgram};
use crate::common::types::{
    atom_from_clvm, chia_dialect, u64_from_atom, usize_from_atom, AllocEncoder, Amount, Error,
    Hash, IntoErr, Node, Program, ProgramRef, Sha256tree,
};
use crate::referee::types::GameMoveDetails;

// How to call the clvm program in this object:
//
// My turn handler takes (readable_new_move amount state last_mover_share entropy) and returns
//       (waiting_handler move validation_program validation_program_hash state max_move_size mover_share
//       message_parser)
// Message parser takes (message amount state move mover_share) and returns error or readable_info
//
// their turn handler takes (amount pre_state state last_move last_mover_share
//       new_move new_validation_info_hash new_max_move_size new_mover_share) and returns
//       (readable_info evidence_list moving_handler message_optional) or
//       (SLASH evidence)

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
    pub waiting_handler: GameHandler,
    pub message_parser: Option<MessageHandler>,
}

pub struct TheirTurnInputs<'a> {
    pub amount: Amount,
    pub pre_state: NodePtr,
    pub state: NodePtr,

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
    pub fn to_nodeptr(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        match self {
            GameHandler::MyTurnHandler(n) => n.to_nodeptr(allocator),
            GameHandler::TheirTurnHandler(n) => n.to_nodeptr(allocator),
        }
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
                    (inputs.last_mover_share.clone(), (inputs.entropy.clone(), ())),
                ),
            ),
        )
            .to_clvm(allocator)
            .into_gen()?;

        let handler_node = self.get_my_turn_handler(allocator)?;
        let handler_args_hex = Node(handler_args).to_hex(allocator)?;
        let handler_args_prefix = &handler_args_hex[..handler_args_hex.len().min(96)];
        debug!(
            "my-turn handler args len={} prefix={}{}",
            handler_args_hex.len(),
            handler_args_prefix,
            if handler_args_hex.len() > handler_args_prefix.len() {
                "..."
            } else {
                ""
            }
        );
        let run_result = run_code(allocator, handler_node, handler_args, false);

        if let Err(Error::ClvmErr(EvalErr(x, ty))) = &run_result {
            let dis = Program::from_nodeptr(allocator, *x)?;
            debug!("error {ty} from clvm during my turn handler: {dis:?}");
        }

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
        let name = std::str::from_utf8(name_atom).expect("remove this in the final version");
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
        debug!("MOVER_SHARE {mover_share:?}");
        let message_parser = if pl.len() <= 9 || pl[9] == allocator.allocator().nil() {
            None
        } else {
            Some(MessageHandler::from_nodeptr(allocator, pl[9])?)
        };

        let get_hash = |allocator: &mut AllocEncoder, loc: usize| {
            if let Some(h) = atom_from_clvm(allocator, pl[loc]).map(|a| Hash::from_slice(&a)) {
                Ok(h)
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
            waiting_handler: GameHandler::their_handler_from_nodeptr(allocator, pl[8])?,
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
                            inputs.new_move.validation_info_hash.clone(),
                            (inputs.new_move.basic.mover_share.clone(), ()),
                        ),
                    ),
                ),
            ),
        )
            .to_clvm(allocator)
            .into_gen()?;

        let handler_node = self.get_their_turn_handler(allocator)?;
        debug!("call their turn handler: is_my_turn={}", self.is_my_turn());
        debug!(
            "call their turn structured: move_len={} move_hex={} pre_state_len={} state_len={} pre_state={:?} state={:?}",
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
        );

        let run_result_e = run_code(
            allocator,
            handler_node,
            handler_args,
            get_their_turn_debug_flag(inputs),
        );

        if let Err(Error::ClvmErr(EvalErr(n, desc))) = &run_result_e {
            let failing_hex = Node(*n).to_hex(allocator)?;
            let failing_prefix = &failing_hex[..failing_hex.len().min(96)];
            debug!(
                "error {desc} from their turn handler: node_len={} node_prefix={}{}",
                failing_hex.len(),
                failing_prefix,
                if failing_hex.len() > failing_prefix.len() {
                    "..."
                } else {
                    ""
                }
            );
        }

        let run_result = match run_result_e {
            Ok(v) => v,
            Err(Error::ClvmErr(EvalErr(n, desc))) => {
                let failing_hex = Node(n).to_hex(allocator)?;
                let failing_prefix = &failing_hex[..failing_hex.len().min(96)];
                return Err(Error::StrErr(format!(
                    "their turn handler failed: desc={desc} move_len={} move_hex={} pre_state_len={} state_len={} pre_state={:?} state={:?} node_len={} node_prefix={}{}",
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
                // Backward compatibility: some handlers returned compact form
                // (0 readable_info next_handler) with no slash-evidence slot.
                if pl.len() == 3 {
                    let their_turn_move_data = TheirTurnMoveData {
                        readable_move: Program::from_nodeptr(allocator, pl[1])?.into(),
                        mover_share: inputs.new_move.basic.mover_share.clone(),
                        slash_evidence: Vec::new(),
                    };
                    return Ok(TheirTurnResult::MakeMove(
                        game_handler::GameHandler::HandlerV1(GameHandler::my_handler_from_nodeptr(
                            allocator, pl[2],
                        )?),
                        Vec::new(),
                        their_turn_move_data,
                    ));
                }
            }
        }

        if pl.len() < offset + 2 {
            return Err(Error::StrErr(format!(
                "bad length for move result {}",
                Node(run_result).to_hex(allocator)?
            )));
        }

        let decode_slash_evidence = |allocator: &mut AllocEncoder, index: Option<usize>| {
            let mut lst = Vec::new();
            let lst_nodeptr = index
                .and_then(|i| proper_list(allocator.allocator(), pl[i], true))
                .unwrap_or_default();

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
                game_handler::GameHandler::HandlerV1(GameHandler::my_handler_from_nodeptr(
                    allocator,
                    pl[offset + 2],
                )?),
                message_data,
                their_turn_move_data,
            ))
        }
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
        let run_prog_hex = Node(run_prog).to_hex(allocator)?;
        let run_prog_prefix = &run_prog_hex[..run_prog_hex.len().min(96)];
        debug!(
            "message parser program hash={:?} len={} prefix={}",
            self.0.sha256tree(allocator),
            run_prog_hex.len(),
            run_prog_prefix
        );
        let args_hex = Node(args).to_hex(allocator)?;
        let args_prefix = &args_hex[..args_hex.len().min(96)];
        debug!(
            "running message handler args len={} prefix={}",
            args_hex.len(),
            args_prefix
        );
        let run_result = run_code(allocator, run_prog, args, false);

        if run_result.is_err() {
            debug!("MESSAGE PARSER RETURNED ERROR {run_result:?}");
            todo!();
        }

        ReadableMove::from_nodeptr(allocator, run_result?)
    }
}
