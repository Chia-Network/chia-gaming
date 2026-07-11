use std::rc::Rc;

use clvm_traits::ToClvm;
use clvmr::{run_program, NodePtr};

use crate::utils::{non_nil, proper_list};

use crate::channel_handler::game_handler::GameHandler;
use crate::channel_handler::game_start_info::GameStartInfo;
use crate::channel_handler::types::StateUpdateProgram;
use crate::common::types::{
    atom_from_clvm, chia_dialect, u64_from_atom, usize_from_atom, AllocEncoder, Amount, Error,
    GameID, Hash, IntoErr, Program, Puzzle, Sha256tree, Timeout, MAX_BLOCK_COST_CLVM,
};

/// One canonical game returned by a proposal factory.
///
/// Contributions and `sender_goes_first` are always oriented to the sender of
/// the proposal. Both peers execute the same factory result and select one of
/// the two handlers based only on which side of the proposal they occupy.
#[derive(Clone)]
pub struct FactoryGame {
    pub sender_contribution: Amount,
    pub receiver_contribution: Amount,
    pub amount: Amount,
    pub sender_goes_first: bool,
    pub initial_validation_program_hash: Hash,
    pub initial_move: Vec<u8>,
    pub initial_max_move_size: usize,
    pub initial_state: Rc<Program>,
    pub initial_mover_share: u64,
    pub my_turn_handler: Program,
    pub their_turn_handler: Program,
    pub initial_validation_program: Rc<Program>,
}

impl FactoryGame {
    pub fn game_start(
        &self,
        game_id: &GameID,
        timeout: &Timeout,
        sender_side: bool,
    ) -> GameStartInfo {
        let is_my_turn = sender_side == self.sender_goes_first;
        let handler_program = if is_my_turn {
            self.my_turn_handler.clone()
        } else {
            self.their_turn_handler.clone()
        };
        let game_handler = if is_my_turn {
            GameHandler::MyTurnHandler(handler_program.into())
        } else {
            GameHandler::TheirTurnHandler(handler_program.into())
        };
        let (my_contribution, their_contribution) = if sender_side {
            (
                self.sender_contribution.clone(),
                self.receiver_contribution.clone(),
            )
        } else {
            (
                self.receiver_contribution.clone(),
                self.sender_contribution.clone(),
            )
        };

        GameStartInfo {
            game_id: *game_id,
            amount: self.amount.clone(),
            game_handler,
            timeout: timeout.clone(),
            my_contribution_this_game: my_contribution,
            their_contribution_this_game: their_contribution,
            initial_validation_program: StateUpdateProgram::new_hash(
                self.initial_validation_program.clone(),
                "initial",
                self.initial_validation_program_hash.clone(),
            ),
            initial_state: self.initial_state.clone().into(),
            initial_move: self.initial_move.clone(),
            initial_max_move_size: self.initial_max_move_size,
            initial_mover_share: Amount::new(self.initial_mover_share),
        }
    }
}

struct ProposalGameSpec {
    my_contribution: Amount,
    their_contribution: Amount,
    amount: Amount,
    initial_validation_program_hash: Hash,
    initial_move: Vec<u8>,
    initial_max_move_size: usize,
    initial_state: Rc<Program>,
    initial_mover_share: u64,
}

#[derive(Clone)]
pub struct GameStart {
    pub id: GameID,
    pub initial_mover_handler: GameHandler,
    pub initial_move: Vec<u8>,
    pub initial_max_move_size: usize,
    pub initial_validation_program: StateUpdateProgram,
    pub initial_validation_program_hash: Hash,
    pub initial_state: Rc<Program>,
    pub initial_mover_share: u64,
}

impl GameStart {
    pub fn new(
        allocator: &mut AllocEncoder,
        game_id: &GameID,
        template_list: &[NodePtr],
    ) -> Result<GameStart, Error> {
        if template_list.len() != 11 {
            return Err(Error::StrErr(format!(
                "calpoker template returned incorrect property list {}",
                template_list.len(),
            )));
        }

        let is_my_turn = non_nil(allocator.allocator(), template_list[1]);
        let initial_mover_handler = if is_my_turn {
            GameHandler::my_handler_from_nodeptr(allocator, template_list[2])?
        } else {
            GameHandler::their_handler_from_nodeptr(allocator, template_list[2])?
        };

        let validation_prog = Rc::new(Program::from_nodeptr(allocator, template_list[5])?);
        let initial_validation_program =
            StateUpdateProgram::new(allocator, "initial", validation_prog);
        let initial_validation_program_hash =
            if let Some(a) = atom_from_clvm(allocator, template_list[6]) {
                Hash::from_slice(&a)?
            } else {
                return Err(Error::StrErr(
                    "not an atom for initial_validation_hash".to_string(),
                ));
            };
        let initial_state_node = template_list[7];
        let initial_state = Rc::new(Program::from_nodeptr(allocator, initial_state_node)?);
        let initial_move = atom_from_clvm(allocator, template_list[8]).unwrap_or_default();
        let initial_max_move_size = atom_from_clvm(allocator, template_list[9])
            .and_then(|a| usize_from_atom(&a))
            .ok_or_else(|| {
                Error::StrErr("initial_max_move_size is not a valid atom".to_string())
            })?;
        let initial_mover_share = atom_from_clvm(allocator, template_list[10])
            .and_then(|a| u64_from_atom(&a))
            .ok_or_else(|| Error::StrErr("initial_mover_share is not a valid atom".to_string()))?;
        Ok(GameStart {
            id: *game_id,
            initial_max_move_size,
            initial_validation_program,
            initial_validation_program_hash,
            initial_state,
            initial_move,
            initial_mover_share,
            initial_mover_handler,
        })
    }

    pub fn game_start(
        &self,
        game_id: &GameID,
        amount: &Amount,
        timeout: &Timeout,
        my_contribution: &Amount,
        their_contribution: &Amount,
    ) -> GameStartInfo {
        GameStartInfo {
            game_id: *game_id,
            amount: amount.clone(),
            game_handler: self.initial_mover_handler.clone(),
            timeout: timeout.clone(),
            my_contribution_this_game: my_contribution.clone(),
            their_contribution_this_game: their_contribution.clone(),
            initial_validation_program: self.initial_validation_program.clone(),
            initial_state: self.initial_state.clone().into(),
            initial_move: self.initial_move.clone(),
            initial_max_move_size: self.initial_max_move_size,
            initial_mover_share: Amount::new(self.initial_mover_share),
        }
    }
}

#[derive(Clone)]
pub struct Game {
    pub starts: Vec<GameStart>,
}

impl Game {
    /// Run the canonical atomic proposal factory.
    ///
    /// Parameters are the exact CLVM object sent over the wire. The result is a
    /// non-empty proper list of 12-field game records:
    /// (sender_contribution receiver_contribution amount sender_goes_first
    ///  initial_validator_hash initial_move initial_max_move_size initial_state
    ///  initial_mover_share my_turn_handler their_turn_handler initial_validator)
    pub fn run_factory(
        allocator: &mut AllocEncoder,
        factory_program: Puzzle,
        parameters: &Program,
    ) -> Result<Vec<FactoryGame>, Error> {
        let args = parameters.to_clvm(allocator).into_gen()?;
        let factory_clvm = factory_program.to_clvm(allocator).into_gen()?;
        let result = run_program(
            allocator.allocator(),
            &chia_dialect(),
            factory_clvm,
            args,
            MAX_BLOCK_COST_CLVM,
        )
        .into_gen()
        .map_err(|e| Error::StrErr(format!("proposal factory failed: error={e:?}")))?
        .1;
        let records = proper_list(allocator.allocator(), result, true)
            .ok_or_else(|| Error::StrErr("proposal factory did not return a proper list".into()))?;
        if records.is_empty() {
            return Err(Error::StrErr(
                "proposal factory returned no games".to_string(),
            ));
        }

        let mut games = Vec::with_capacity(records.len());
        for (index, record) in records.into_iter().enumerate() {
            let fields = proper_list(allocator.allocator(), record, true).ok_or_else(|| {
                Error::StrErr(format!("proposal factory game {index} is not a proper list"))
            })?;
            if fields.len() != 12 {
                return Err(Error::StrErr(format!(
                    "proposal factory game {index} has {} fields, expected 12",
                    fields.len()
                )));
            }

            let turn_atom = atom_from_clvm(allocator, fields[3]).ok_or_else(|| {
                Error::StrErr(format!(
                    "proposal factory game {index} sender_goes_first is not an atom"
                ))
            })?;
            let sender_goes_first = match turn_atom.as_slice() {
                [] => false,
                [1] => true,
                _ => {
                    return Err(Error::StrErr(format!(
                        "proposal factory game {index} sender_goes_first is not canonical boolean"
                    )));
                }
            };

            let initial_validation_program_hash = Hash::from_nodeptr(allocator, fields[4])?;
            let initial_validation_program =
                Rc::new(Program::from_nodeptr(allocator, fields[11])?);
            let actual_hash = initial_validation_program.sha256tree(allocator);
            if actual_hash.hash() != &initial_validation_program_hash {
                return Err(Error::StrErr(format!(
                    "proposal factory game {index} initial validator hash mismatch"
                )));
            }

            games.push(FactoryGame {
                sender_contribution: Amount::from_clvm(allocator, fields[0])?,
                receiver_contribution: Amount::from_clvm(allocator, fields[1])?,
                amount: Amount::from_clvm(allocator, fields[2])?,
                sender_goes_first,
                initial_validation_program_hash,
                initial_move: atom_from_clvm(allocator, fields[5])
                    .ok_or_else(|| {
                        Error::StrErr(format!(
                            "proposal factory game {index} initial_move is not an atom"
                        ))
                    })?
                    .to_vec(),
                initial_max_move_size: atom_from_clvm(allocator, fields[6])
                    .and_then(|a| usize_from_atom(&a))
                    .ok_or_else(|| {
                        Error::StrErr(format!(
                            "proposal factory game {index} has invalid max move size"
                        ))
                    })?,
                initial_state: Rc::new(Program::from_nodeptr(allocator, fields[7])?),
                initial_mover_share: atom_from_clvm(allocator, fields[8])
                    .and_then(|a| u64_from_atom(&a))
                    .ok_or_else(|| {
                        Error::StrErr(format!(
                            "proposal factory game {index} has invalid mover share"
                        ))
                    })?,
                my_turn_handler: Program::from_nodeptr(allocator, fields[9])?,
                their_turn_handler: Program::from_nodeptr(allocator, fields[10])?,
                initial_validation_program,
            });
        }

        Ok(games)
    }

    /// Run make_proposal(my_contribution[, parameters]) and parse the result into
    /// (wire_data, handler, validator, game_spec fields).
    fn run_make_proposal(
        allocator: &mut AllocEncoder,
        proposal_program: Puzzle,
        my_contribution: &Amount,
        parameters: &Program,
    ) -> Result<(NodePtr, GameHandler, NodePtr, ProposalGameSpec), Error> {
        let args = if parameters.bytes() == [0x80] {
            (my_contribution.clone(), ())
                .to_clvm(allocator)
                .into_gen()?
        } else {
            (my_contribution.clone(), (parameters.clone(), ()))
                .to_clvm(allocator)
                .into_gen()?
        };
        let proposal_clvm = proposal_program.to_clvm(allocator).into_gen()?;
        let result = run_program(
            allocator.allocator(),
            &chia_dialect(),
            proposal_clvm,
            args,
            MAX_BLOCK_COST_CLVM,
        )
        .into_gen()
        .map_err(|e| {
            Error::StrErr(format!(
                "make_proposal failed: my_contribution={my_contribution:?} error={e:?}"
            ))
        })?
        .1;

        // Result is (wire_data local_data)
        // wire_data = (my_contribution their_contribution ((amount we_go_first vh im mms is ms)))
        // local_data = ((handler validator))
        let result_list = proper_list(allocator.allocator(), result, true)
            .ok_or_else(|| Error::StrErr("make_proposal didn't return a list".to_string()))?;
        if result_list.len() < 2 {
            return Err(Error::StrErr(format!(
                "make_proposal returned {} elements, expected 2",
                result_list.len()
            )));
        }
        let wire_data = result_list[0];
        let local_data = result_list[1];

        // Parse wire_data to extract game_spec:
        // (my_contribution their_contribution ((amount we_go_first vh im mms is ms)))
        let wire_list = proper_list(allocator.allocator(), wire_data, true)
            .ok_or_else(|| Error::StrErr("wire_data not a list".to_string()))?;
        if wire_list.len() < 3 {
            return Err(Error::StrErr("wire_data too short".to_string()));
        }
        let game_spec_wrapper = proper_list(allocator.allocator(), wire_list[2], true)
            .ok_or_else(|| Error::StrErr("wire_data[2] not a list".to_string()))?;
        if game_spec_wrapper.is_empty() {
            return Err(Error::StrErr("game_spec wrapper is empty".to_string()));
        }
        let game_spec_list = proper_list(allocator.allocator(), game_spec_wrapper[0], true)
            .ok_or_else(|| Error::StrErr("game_spec not a list".to_string()))?;
        if game_spec_list.len() < 7 {
            return Err(Error::StrErr(format!(
                "game_spec has {} elements, expected 7",
                game_spec_list.len()
            )));
        }

        let spec = ProposalGameSpec {
            my_contribution: Amount::from_clvm(allocator, wire_list[0])?,
            their_contribution: Amount::from_clvm(allocator, wire_list[1])?,
            amount: Amount::from_clvm(allocator, game_spec_list[0])?,
            // game_spec_list[1] is we_go_first
            initial_validation_program_hash: Hash::from_nodeptr(allocator, game_spec_list[2])?,
            initial_move: atom_from_clvm(allocator, game_spec_list[3]).unwrap_or_default(),
            initial_max_move_size: atom_from_clvm(allocator, game_spec_list[4])
                .and_then(|a| usize_from_atom(&a))
                .ok_or_else(|| Error::StrErr("bad max_move_size in game_spec".to_string()))?,
            initial_state: Rc::new(Program::from_nodeptr(allocator, game_spec_list[5])?),
            initial_mover_share: atom_from_clvm(allocator, game_spec_list[6])
                .and_then(|a| u64_from_atom(&a))
                .ok_or_else(|| Error::StrErr("bad mover_share in game_spec".to_string()))?,
        };

        // Parse local_data = ((handler validator))
        let local_list = proper_list(allocator.allocator(), local_data, true)
            .ok_or_else(|| Error::StrErr("local_data not a list".to_string()))?;
        if local_list.is_empty() {
            return Err(Error::StrErr("local_data is empty".to_string()));
        }
        let handler_info = proper_list(allocator.allocator(), local_list[0], true)
            .ok_or_else(|| Error::StrErr("handler_info not a list".to_string()))?;
        if handler_info.len() < 2 {
            return Err(Error::StrErr("handler_info too short".to_string()));
        }
        let handler = GameHandler::my_handler_from_nodeptr(allocator, handler_info[0])?;
        let validator_node = handler_info[1];

        Ok((wire_data, handler, validator_node, spec))
    }

    /// Run calpoker_parser(wire_data) and extract handler + validator.
    fn run_parser(
        allocator: &mut AllocEncoder,
        parser_program: Puzzle,
        wire_data: NodePtr,
    ) -> Result<(GameHandler, NodePtr), Error> {
        let parser_clvm = parser_program.to_clvm(allocator).into_gen()?;
        // Parser expects wire_data as its environment (spread args)
        let result = run_program(
            allocator.allocator(),
            &chia_dialect(),
            parser_clvm,
            wire_data,
            MAX_BLOCK_COST_CLVM,
        )
        .into_gen()
        .map_err(|e| Error::StrErr(format!("parser failed: error={e:?}")))?
        .1;

        // Result is (readable ((validator handler)))
        let result_list = proper_list(allocator.allocator(), result, true)
            .ok_or_else(|| Error::StrErr("parser didn't return a list".to_string()))?;
        if result_list.len() < 2 {
            return Err(Error::StrErr(format!(
                "parser returned {} elements, expected 2",
                result_list.len()
            )));
        }
        let handler_wrapper = proper_list(allocator.allocator(), result_list[1], true)
            .ok_or_else(|| Error::StrErr("parser handler_wrapper not a list".to_string()))?;
        if handler_wrapper.is_empty() {
            return Err(Error::StrErr("parser handler_wrapper is empty".to_string()));
        }
        let handler_info = proper_list(allocator.allocator(), handler_wrapper[0], true)
            .ok_or_else(|| Error::StrErr("parser handler_info not a list".to_string()))?;
        if handler_info.len() < 2 {
            return Err(Error::StrErr("parser handler_info too short".to_string()));
        }
        // Parser returns (validator handler) in handler_info
        let validator_node = handler_info[0];
        let handler = GameHandler::their_handler_from_nodeptr(allocator, handler_info[1])?;

        Ok((handler, validator_node))
    }

    pub fn new_from_proposal(
        allocator: &mut AllocEncoder,
        as_alice: bool,
        game_id: &GameID,
        proposal_program: Puzzle,
        parser_program: Option<Puzzle>,
        amount: &Amount,
        my_contribution: &Amount,
        their_contribution: &Amount,
        parameters: &Program,
    ) -> Result<Game, Error> {
        let (wire_data, alice_handler, alice_validator_node, spec) =
            Self::run_make_proposal(allocator, proposal_program, my_contribution, parameters)?;

        if spec.amount != *amount
            || spec.my_contribution != *my_contribution
            || spec.their_contribution != *their_contribution
        {
            return Err(Error::StrErr(format!(
                "proposal factory economics mismatch: \
                 factory amount={} contributions={}/{}; \
                 proposal amount={} contributions={}/{}",
                spec.amount,
                spec.my_contribution,
                spec.their_contribution,
                amount,
                my_contribution,
                their_contribution,
            )));
        }

        let (handler, validator_node) = if as_alice {
            (alice_handler, alice_validator_node)
        } else {
            let parser = parser_program
                .ok_or_else(|| Error::StrErr("no parser program for responder".to_string()))?;
            Self::run_parser(allocator, parser, wire_data)?
        };

        // Both validation_prog and spec.initial_validation_program_hash originate
        // from the same local run_make_proposal execution — no peer-supplied hash
        // is trusted here.  (See HANDLER_GUIDE.md § "Proposal Execution Model".)
        let validation_prog = Rc::new(Program::from_nodeptr(allocator, validator_node)?);
        let initial_validation_program = StateUpdateProgram::new_hash(
            validation_prog,
            "initial",
            spec.initial_validation_program_hash.clone(),
        );

        let start = GameStart {
            id: *game_id,
            initial_mover_handler: handler,
            initial_validation_program,
            initial_validation_program_hash: spec.initial_validation_program_hash,
            initial_state: spec.initial_state,
            initial_move: spec.initial_move,
            initial_max_move_size: spec.initial_max_move_size,
            initial_mover_share: spec.initial_mover_share,
        };

        Ok(Game {
            starts: vec![start],
        })
    }

    pub fn new_program(
        allocator: &mut AllocEncoder,
        as_alice: bool,
        game_id: &GameID,
        poker_generator: Puzzle,
        args_program: Rc<Program>,
    ) -> Result<Game, Error> {
        let mut starts = Vec::new();

        let args = (as_alice, args_program.clone())
            .to_clvm(allocator)
            .into_gen()?;

        let poker_generator_clvm = poker_generator.to_clvm(allocator).into_gen()?;
        let template_clvm = match run_program(
            allocator.allocator(),
            &chia_dialect(),
            poker_generator_clvm,
            args,
            MAX_BLOCK_COST_CLVM,
        )
        .into_gen()
        {
            Ok(r) => r.1,
            Err(e) => {
                return Err(Error::StrErr(format!(
                    "factory run failed: as_alice={as_alice} args={args_program:?} error={e:?}"
                )));
            }
        };
        let template_list =
            if let Some(lst) = proper_list(allocator.allocator(), template_clvm, true) {
                lst
            } else {
                return Err(Error::StrErr(
                    "poker program didn't return a list".to_string(),
                ));
            };
        if template_list.is_empty() {
            return Err(Error::StrErr("not even one game returned".to_string()));
        }

        for game in template_list.iter() {
            let game_fields = if let Some(lst) = proper_list(allocator.allocator(), *game, true) {
                lst
            } else {
                return Err(Error::StrErr("bad template list".to_string()));
            };

            starts.push(GameStart::new(allocator, game_id, &game_fields)?);
        }

        Ok(Game { starts })
    }

    /// Return a pair of GameStartInfo which can be used as the starts for two
    /// players in a game.
    pub fn game_start(
        &self,
        game_id: &GameID,
        our_contribution: &Amount,
        their_contribution: &Amount,
        timeout: &Timeout,
    ) -> GameStartInfo {
        let amount = our_contribution.clone() + their_contribution.clone();
        self.starts[0].game_start(
            game_id,
            &amount,
            timeout,
            our_contribution,
            their_contribution,
        )
    }
}

#[cfg(test)]
mod atomic_factory_tests {
    use super::*;

    fn factory_game(sender_goes_first: bool) -> FactoryGame {
        FactoryGame {
            sender_contribution: Amount::new(10),
            receiver_contribution: Amount::new(20),
            amount: Amount::new(30),
            sender_goes_first,
            initial_validation_program_hash: Hash::default(),
            initial_move: vec![],
            initial_max_move_size: 32,
            initial_state: Rc::new(Program::from_bytes(&[0x80])),
            initial_mover_share: 0,
            my_turn_handler: Program::from_bytes(&[0x80]),
            their_turn_handler: Program::from_bytes(&[0x80]),
            initial_validation_program: Rc::new(Program::from_bytes(&[0x80])),
        }
    }

    #[test]
    fn factory_game_selects_handlers_and_contributions_for_both_sides() {
        for sender_goes_first in [false, true] {
            let game = factory_game(sender_goes_first);
            let sender = game.game_start(&GameID(1), &Timeout::new(15), true);
            let receiver = game.game_start(&GameID(1), &Timeout::new(15), false);

            assert_eq!(sender.is_my_turn(), sender_goes_first);
            assert_eq!(receiver.is_my_turn(), !sender_goes_first);
            assert_eq!(sender.my_contribution_this_game, Amount::new(10));
            assert_eq!(sender.their_contribution_this_game, Amount::new(20));
            assert_eq!(receiver.my_contribution_this_game, Amount::new(20));
            assert_eq!(receiver.their_contribution_this_game, Amount::new(10));
        }
    }
}
