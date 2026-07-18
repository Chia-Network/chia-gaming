use std::rc::Rc;

use clvm_traits::ToClvm;
use clvmr::run_program;

use crate::utils::proper_list;

use crate::channel_state::game_handler::GameHandler;
use crate::channel_state::game_start_info::GameStartInfo;
use crate::channel_state::types::StateUpdateProgram;
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

/// Namespace for factory helpers. Live starts are [`GameStartInfo`] via [`FactoryGame`].
pub struct Game;

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
                Error::StrErr(format!(
                    "proposal factory game {index} is not a proper list"
                ))
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
            let initial_validation_program = Rc::new(Program::from_nodeptr(allocator, fields[11])?);
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
