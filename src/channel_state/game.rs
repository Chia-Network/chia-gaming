use std::rc::Rc;

use clvm_traits::ToClvm;
use clvmr::run_program;

use crate::utils::proper_list;

use crate::channel_state::game_handler::GameHandler;
use crate::channel_state::game_start_info::GameStartInfo;
use crate::channel_state::types::{StateUpdateProgram, ValidationInfo, ValidationProgramRegistry};
use crate::common::types::{
    atom_from_clvm, chia_dialect, u64_from_atom, usize_from_atom, AllocEncoder, Amount, Error,
    GameID, Hash, IntoErr, Program, Puzzle, Timeout, MAX_BLOCK_COST_CLVM,
};

/// One canonical game returned by a proposal factory.
///
/// Contributions and `player_a_goes_first` use the factory's stable player A/B
/// orientation. Rust projects that orientation to either local player.
#[derive(Clone)]
pub struct FactoryGame {
    pub player_a_contribution: Amount,
    pub player_b_contribution: Amount,
    pub amount: Amount,
    pub player_a_goes_first: bool,
    pub initial_move: Vec<u8>,
    pub initial_max_move_size: usize,
    pub initial_state: Rc<Program>,
    pub initial_mover_share: u64,
    pub my_turn_handler: Program,
    pub their_turn_handler: Program,
    pub validation_programs: ValidationProgramRegistry,
}

impl FactoryGame {
    pub fn initial_validation_program(&self) -> StateUpdateProgram {
        self.validation_programs.initial()
    }

    pub fn initial_validation_program_hash(&self) -> &Hash {
        self.validation_programs.initial_hash()
    }

    pub fn initial_validation_info_hash(&self, allocator: &mut AllocEncoder) -> Hash {
        ValidationInfo::new_state_update(
            allocator,
            self.initial_validation_program(),
            self.initial_state.clone(),
        )
        .hash()
        .clone()
    }

    pub fn game_start(
        &self,
        game_id: &GameID,
        timeout: &Timeout,
        local_is_player_a: bool,
    ) -> GameStartInfo {
        let is_my_turn = local_is_player_a == self.player_a_goes_first;
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
        let (my_contribution, their_contribution) = if local_is_player_a {
            (
                self.player_a_contribution.clone(),
                self.player_b_contribution.clone(),
            )
        } else {
            (
                self.player_b_contribution.clone(),
                self.player_a_contribution.clone(),
            )
        };

        GameStartInfo {
            game_id: *game_id,
            amount: self.amount.clone(),
            game_handler,
            timeout: timeout.clone(),
            player_a_contribution: self.player_a_contribution.clone(),
            player_b_contribution: self.player_b_contribution.clone(),
            my_contribution_this_game: my_contribution,
            their_contribution_this_game: their_contribution,
            validation_programs: self.validation_programs.clone(),
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
    /// `arguments` is the uniform proper list
    /// `(player_a_contribution player_b_contribution game_parameters)`.
    /// The result is a
    /// non-empty proper list of 10-field game records:
    /// (player_a_contribution player_b_contribution player_a_goes_first initial_move
    ///  initial_max_move_size initial_state initial_mover_share my_turn_handler
    ///  their_turn_handler validation_programs)
    pub fn run_factory(
        allocator: &mut AllocEncoder,
        factory_program: Puzzle,
        arguments: &Program,
    ) -> Result<Vec<FactoryGame>, Error> {
        let args = arguments.to_clvm(allocator).into_gen()?;
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
            if fields.len() != 10 {
                return Err(Error::StrErr(format!(
                    "proposal factory game {index} has {} fields, expected 10",
                    fields.len()
                )));
            }

            let turn_atom = atom_from_clvm(allocator, fields[2]).ok_or_else(|| {
                Error::StrErr(format!(
                    "proposal factory game {index} player_a_goes_first is not an atom"
                ))
            })?;
            let player_a_goes_first = match turn_atom.as_slice() {
                [] => false,
                [1] => true,
                _ => {
                    return Err(Error::StrErr(format!(
                        "proposal factory game {index} player_a_goes_first is not canonical boolean"
                    )));
                }
            };

            let player_a_contribution = Amount::from_clvm(allocator, fields[0])?;
            let player_b_contribution = Amount::from_clvm(allocator, fields[1])?;
            let amount = player_a_contribution.clone() + player_b_contribution.clone();
            let validation_program_nodes = proper_list(allocator.allocator(), fields[9], true)
                .ok_or_else(|| {
                    Error::StrErr(format!(
                        "proposal factory game {index} validation programs are not a proper list"
                    ))
                })?;
            let mut validation_programs = Vec::with_capacity(validation_program_nodes.len());
            for node in validation_program_nodes {
                validation_programs.push(Rc::new(Program::from_nodeptr(allocator, node)?));
            }
            let validation_programs =
                ValidationProgramRegistry::new(allocator, &validation_programs)?;
            let initial_mover_share = atom_from_clvm(allocator, fields[6])
                .and_then(|a| u64_from_atom(&a))
                .ok_or_else(|| {
                    Error::StrErr(format!(
                        "proposal factory game {index} has invalid mover share"
                    ))
                })?;
            if Amount::new(initial_mover_share) > amount {
                return Err(Error::StrErr(format!(
                    "proposal factory game {index} mover share {initial_mover_share} exceeds amount {}",
                    amount.to_u64()
                )));
            }

            games.push(FactoryGame {
                player_a_contribution,
                player_b_contribution,
                amount,
                player_a_goes_first,
                initial_move: atom_from_clvm(allocator, fields[3])
                    .ok_or_else(|| {
                        Error::StrErr(format!(
                            "proposal factory game {index} initial_move is not an atom"
                        ))
                    })?
                    .to_vec(),
                initial_max_move_size: atom_from_clvm(allocator, fields[4])
                    .and_then(|a| usize_from_atom(&a))
                    .ok_or_else(|| {
                        Error::StrErr(format!(
                            "proposal factory game {index} has invalid max move size"
                        ))
                    })?,
                initial_state: Rc::new(Program::from_nodeptr(allocator, fields[5])?),
                initial_mover_share,
                my_turn_handler: Program::from_nodeptr(allocator, fields[7])?,
                their_turn_handler: Program::from_nodeptr(allocator, fields[8])?,
                validation_programs,
            });
        }

        Ok(games)
    }
}

#[cfg(test)]
mod atomic_factory_tests {
    use super::*;
    use crate::common::types::{Node, Sha256tree};
    use clvmr::NodePtr;

    fn list_from_nodes(allocator: &mut AllocEncoder, nodes: &[NodePtr]) -> NodePtr {
        nodes.iter().rev().fold(NodePtr::NIL, |tail, node| {
            allocator.allocator().new_pair(*node, tail).unwrap()
        })
    }

    fn quoted_factory(
        allocator: &mut AllocEncoder,
        initial_mover_share: u64,
        validation_programs: NodePtr,
    ) -> Puzzle {
        let player_a_contribution = 10u64.to_clvm(allocator).unwrap();
        let player_b_contribution = 0u64.to_clvm(allocator).unwrap();
        let player_a_goes_first = true.to_clvm(allocator).unwrap();
        let initial_move = Vec::<u8>::new().to_clvm(allocator).unwrap();
        let initial_max_move_size = 32u64.to_clvm(allocator).unwrap();
        let initial_state = ().to_clvm(allocator).unwrap();
        let initial_mover_share = initial_mover_share.to_clvm(allocator).unwrap();
        let record = list_from_nodes(
            allocator,
            &[
                player_a_contribution,
                player_b_contribution,
                player_a_goes_first,
                initial_move,
                initial_max_move_size,
                initial_state,
                initial_mover_share,
                NodePtr::NIL,
                NodePtr::NIL,
                validation_programs,
            ],
        );
        let records = list_from_nodes(allocator, &[record]);
        let quote = allocator.allocator().one();
        let factory_node = allocator.allocator().new_pair(quote, records).unwrap();
        Puzzle::from_nodeptr(allocator, factory_node).unwrap()
    }

    #[test]
    fn run_factory_rejects_initial_mover_share_above_amount() {
        let mut allocator = AllocEncoder::new();
        let validator = allocator.allocator().one();
        let validators = list_from_nodes(&mut allocator, &[validator]);
        let factory = quoted_factory(&mut allocator, 11, validators);

        let error = match Game::run_factory(&mut allocator, factory, &Program::nil()) {
            Ok(_) => panic!("factory accepted mover share above amount"),
            Err(error) => error,
        };

        assert!(
            format!("{error:?}").contains("mover share 11 exceeds amount 10"),
            "unexpected error: {error:?}"
        );
    }

    #[test]
    fn run_factory_requires_unique_nonempty_validation_programs() {
        let mut allocator = AllocEncoder::new();

        let empty_factory = quoted_factory(&mut allocator, 0, NodePtr::NIL);
        assert!(Game::run_factory(&mut allocator, empty_factory, &Program::nil()).is_err());

        let validator = allocator.allocator().one();
        let duplicate = list_from_nodes(&mut allocator, &[validator, validator]);
        let duplicate_factory = quoted_factory(&mut allocator, 0, duplicate);
        assert!(Game::run_factory(&mut allocator, duplicate_factory, &Program::nil()).is_err());

        let improper = allocator
            .allocator()
            .new_pair(validator, validator)
            .unwrap();
        let improper_factory = quoted_factory(&mut allocator, 0, improper);
        assert!(Game::run_factory(&mut allocator, improper_factory, &Program::nil()).is_err());
    }

    #[test]
    fn run_factory_uses_first_validation_program_as_identity() {
        let mut allocator = AllocEncoder::new();
        let first = allocator.allocator().one();
        let second = 2u64.to_clvm(&mut allocator).unwrap();
        let expected = Node(first).sha256tree(&mut allocator).hash().clone();
        let validators = list_from_nodes(&mut allocator, &[first, second]);
        let factory = quoted_factory(&mut allocator, 0, validators);

        let games = Game::run_factory(&mut allocator, factory, &Program::nil()).unwrap();
        assert_eq!(games[0].initial_validation_program_hash(), &expected);
        assert_eq!(games[0].validation_programs.len(), 2);
    }

    fn factory_game(player_a_goes_first: bool) -> FactoryGame {
        FactoryGame {
            player_a_contribution: Amount::new(10),
            player_b_contribution: Amount::new(20),
            amount: Amount::new(30),
            player_a_goes_first,
            initial_move: vec![],
            initial_max_move_size: 32,
            initial_state: Rc::new(Program::nil()),
            initial_mover_share: 0,
            my_turn_handler: Program::nil(),
            their_turn_handler: Program::nil(),
            validation_programs: ValidationProgramRegistry::new(
                &mut AllocEncoder::new(),
                &[Rc::new(
                    Program::from_bytes(&[0x01]).expect("serialized validator"),
                )],
            )
            .expect("validator registry"),
        }
    }

    #[test]
    fn factory_game_selects_handlers_and_contributions_for_both_sides() {
        for player_a_goes_first in [false, true] {
            let game = factory_game(player_a_goes_first);
            let player_a = game.game_start(&GameID(1), &Timeout::new(15), true);
            let player_b = game.game_start(&GameID(1), &Timeout::new(15), false);

            assert_eq!(player_a.is_my_turn(), player_a_goes_first);
            assert_eq!(player_b.is_my_turn(), !player_a_goes_first);
            assert_eq!(player_a.player_a_contribution, Amount::new(10));
            assert_eq!(player_a.player_b_contribution, Amount::new(20));
            assert_eq!(player_b.player_a_contribution, Amount::new(10));
            assert_eq!(player_b.player_b_contribution, Amount::new(20));
            assert_eq!(player_a.my_contribution_this_game, Amount::new(10));
            assert_eq!(player_a.their_contribution_this_game, Amount::new(20));
            assert_eq!(player_b.my_contribution_this_game, Amount::new(20));
            assert_eq!(player_b.their_contribution_this_game, Amount::new(10));
        }
    }
}
