use std::rc::Rc;
use std::collections::VecDeque;

use clvm_traits::{ToClvm, clvm_curried_args};
use clvm_utils::CurriedProgram;

use crate::channel_handler::game::Game;
use crate::channel_handler::game_handler::GameHandler;
use crate::channel_handler::types::{StateUpdateProgram, ValidationInfo};
use crate::common::types::{AllocEncoder, Amount, Error, GameID, Hash, IntoErr, Program, Puzzle, PuzzleHash, Timeout};
use crate::common::standard_coin::{ChiaIdentity, read_hex_puzzle};
use crate::referee::types::{GameMoveDetails, GameMoveStateInfo, RefereePuzzleArgs};

pub struct DebugGameCurry {
    mode: String,
    count: usize,
    self_prog: Rc<Program>,
    mover0: PuzzleHash,
    waiter0: PuzzleHash,
}

pub struct DebugGame {
    game: Game,
}

impl DebugGameCurry {
    fn new(
    ) -> DebugGameCurry {
        todo!();
    }
}

/// A driver for the bare debug game, wrapped in a referee coin.
pub struct BareDebugGameDriver {
    game: Game,
    game_id: GameID,

    alice_identity: ChiaIdentity,
    bob_identity: ChiaIdentity,

    i_am_alice: bool,

    move_count: usize,

    timeout: Timeout,
    amount: Amount,

    mod_hash: PuzzleHash,
    nonce: usize,

    max_move_size: usize,
    validation_info: ValidationInfo,

    mover_share: usize,
    previous_validation_info_hash: Option<ValidationInfo>,

    validation_program_queue: VecDeque<StateUpdateProgram>,
    handler: GameHandler,
    state: Rc<Program>,
}

impl BareDebugGameDriver {
    fn new(
        allocator: &mut AllocEncoder,
        game_id: GameID,
        amount: Amount,
        identities: &[&ChiaIdentity],
        referee_coin_puzzle_hash: &PuzzleHash,
        game_hex_file: &str,
    ) -> Result<DebugGame, Error> {
        let raw_program = read_hex_puzzle(allocator, game_hex_file)?;
        let referee_args = RefereePuzzleArgs {
            amount,
            nonce: 0,
            max_move_size: 256,
            mover_puzzle_hash: identities[0].puzzle_hash.clone(),
            waiter_puzzle_hash: identities[1].puzzle_hash.clone(),
            timeout: Timeout::new(10),
            game_move: GameMoveDetails {
                basic: GameMoveStateInfo {
                    move_made: vec![],
                    mover_share: Amount::default(),
                },
                validation_info_hash: Hash::default(),
            },
            previous_validation_info_hash: None,
            referee_coin_puzzle_hash: referee_coin_puzzle_hash.clone(),
        };
        let curried = CurriedProgram {
            program: raw_program.to_clvm(allocator).into_gen()?,
            args: clvm_curried_args!((
                "factory",
                (
                    referee_args,
                    ()
                )
            ))
        }.to_clvm(allocator).into_gen()?;
        let curried_prog = Program::from_nodeptr(allocator, curried)?;
        let game = Game::new_program(allocator, game_id, curried_prog.into())?;
        Ok(DebugGame {
            game
        })
    }
}

#[test]
fn test_debug_game_factory() {
    todo!();
}
