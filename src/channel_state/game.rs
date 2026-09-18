use std::rc::Rc;

use clvm_traits::ToClvm;
use clvmr::run_program;

use crate::channel_state::game_handler::GameHandler;
use crate::channel_state::game_start_info::GameStartInfo;
use crate::channel_state::types::{StateUpdateProgram, ValidationInfo, ValidationProgramRegistry};
use crate::common::types::{
    atom_from_clvm, chia_dialect, u64_from_atom, usize_from_atom, AllocEncoder, Amount, Error,
    GameID, Hash, IntoErr, Program, Puzzle, Timeout, MAX_BLOCK_COST_CLVM,
};

#[path = "../factory_abi.rs"]
mod factory_abi;

/// One canonical game returned by a proposal factory.
///
/// Contributions and turn ownership are relative to the proposal origin.
#[derive(Clone)]
pub struct FactoryGame {
    pub proposer_contribution: Amount,
    pub accepter_contribution: Amount,
    pub amount: Amount,
    pub proposer_goes_first: bool,
    pub initial_move: Vec<u8>,
    pub initial_max_move_size: usize,
    pub initial_state: Rc<Program>,
    pub initial_mover_share: u64,
    pub my_turn_handler: Program,
    pub their_turn_handler: Program,
    pub validation_programs: ValidationProgramRegistry,
    pub readable_parameters: Program,
}

pub enum FactoryResult {
    Success(Vec<FactoryGame>),
    InsufficientBalance {
        proposer_balance_short: bool,
        accepter_balance_short: bool,
    },
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
        sender_is_player_a: bool,
        local_is_player_a: bool,
    ) -> GameStartInfo {
        let player_a_contribution = if sender_is_player_a {
            self.proposer_contribution.clone()
        } else {
            self.accepter_contribution.clone()
        };
        let player_b_contribution = if sender_is_player_a {
            self.accepter_contribution.clone()
        } else {
            self.proposer_contribution.clone()
        };
        let player_a_goes_first = self.proposer_goes_first == sender_is_player_a;
        let is_my_turn = local_is_player_a == player_a_goes_first;
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
            (player_a_contribution.clone(), player_b_contribution.clone())
        } else {
            (player_b_contribution.clone(), player_a_contribution.clone())
        };

        GameStartInfo {
            game_id: *game_id,
            amount: self.amount.clone(),
            game_handler,
            timeout: timeout.clone(),
            player_a_contribution,
            player_b_contribution,
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
    /// `(proposer_reserve accepter_reserve game_parameters)`.
    /// Success is `(1 records)`, where records is a non-empty proper list of
    /// 11-field proposal-relative game records:
    /// (proposer_contribution accepter_contribution proposer_goes_first initial_move
    ///  initial_max_move_size initial_state initial_mover_share my_turn_handler
    ///  their_turn_handler validation_programs readable_parameters).
    /// Insufficient balance is `(0 proposer_short accepter_short)`.
    pub fn run_factory(
        allocator: &mut AllocEncoder,
        factory_program: Puzzle,
        arguments: &Program,
    ) -> Result<FactoryResult, Error> {
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
        let records = match factory_abi::parse_factory_result(
            allocator.allocator(),
            result,
            "proposal factory",
        )
        .map_err(Error::StrErr)?
        {
            factory_abi::FactoryResultNodes::Success(records) => records,
            factory_abi::FactoryResultNodes::InsufficientBalance {
                proposer_balance_short,
                accepter_balance_short,
            } => {
                return Ok(FactoryResult::InsufficientBalance {
                    proposer_balance_short,
                    accepter_balance_short,
                });
            }
        };

        let mut games = Vec::with_capacity(records.len());
        for (index, record) in records.into_iter().enumerate() {
            let fields = record.fields;
            let proposer_contribution = Amount::from_clvm(allocator, fields[0])?;
            let accepter_contribution = Amount::from_clvm(allocator, fields[1])?;
            let amount = proposer_contribution.clone() + accepter_contribution.clone();
            let mut validation_programs = Vec::with_capacity(record.validation_programs.len());
            for node in record.validation_programs {
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
                proposer_contribution,
                accepter_contribution,
                amount,
                proposer_goes_first: record.proposer_goes_first,
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
                readable_parameters: Program::from_nodeptr(allocator, fields[10])?,
            });
        }

        Ok(FactoryResult::Success(games))
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
                NodePtr::NIL,
            ],
        );
        let records = list_from_nodes(allocator, &[record]);
        let success = 1u64.to_clvm(allocator).unwrap();
        let envelope = list_from_nodes(allocator, &[success, records]);
        let quote = allocator.allocator().one();
        let factory_node = allocator.allocator().new_pair(quote, envelope).unwrap();
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

        let games = match Game::run_factory(&mut allocator, factory, &Program::nil()).unwrap() {
            FactoryResult::Success(games) => games,
            FactoryResult::InsufficientBalance { .. } => panic!("unexpected shortage"),
        };
        assert_eq!(games[0].initial_validation_program_hash(), &expected);
        assert_eq!(games[0].validation_programs.len(), 2);
    }

    fn factory_game(player_a_goes_first: bool) -> FactoryGame {
        FactoryGame {
            proposer_contribution: Amount::new(10),
            accepter_contribution: Amount::new(20),
            amount: Amount::new(30),
            proposer_goes_first: player_a_goes_first,
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
            readable_parameters: Program::nil(),
        }
    }

    #[test]
    fn factory_game_selects_handlers_and_contributions_for_both_sides() {
        for player_a_goes_first in [false, true] {
            for sender_is_player_a in [false, true] {
                let game = factory_game(player_a_goes_first);
                let player_a =
                    game.game_start(&GameID(1), &Timeout::new(15), sender_is_player_a, true);
                let player_b =
                    game.game_start(&GameID(1), &Timeout::new(15), sender_is_player_a, false);
                let expected_a = Amount::new(if sender_is_player_a { 10 } else { 20 });
                let expected_b = Amount::new(if sender_is_player_a { 20 } else { 10 });
                let a_goes_first = player_a_goes_first == sender_is_player_a;

                assert_eq!(player_a.is_my_turn(), a_goes_first);
                assert_eq!(player_b.is_my_turn(), !a_goes_first);
                assert_eq!(player_a.player_a_contribution, expected_a);
                assert_eq!(player_a.player_b_contribution, expected_b);
                assert_eq!(player_b.player_a_contribution, expected_a);
                assert_eq!(player_b.player_b_contribution, expected_b);
                assert_eq!(player_a.my_contribution_this_game, expected_a);
                assert_eq!(player_a.their_contribution_this_game, expected_b);
                assert_eq!(player_b.my_contribution_this_game, expected_b);
                assert_eq!(player_b.their_contribution_this_game, expected_a);
            }
        }
    }
}
