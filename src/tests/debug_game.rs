use std::rc::Rc;
use std::collections::VecDeque;

use rand_chacha::ChaCha8Rng;
use rand::prelude::*;

use clvmr::NodePtr;

use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError, clvm_curried_args};
use clvm_utils::CurriedProgram;

use crate::channel_handler::game::Game;
use crate::channel_handler::game_handler::GameHandler;
use crate::channel_handler::types::{GameStartInfo, StateUpdateProgram, ValidationInfo};
use crate::common::types::{AllocEncoder, Amount, Error, GameID, Hash, IntoErr, PrivateKey, Program, ProgramRef, Puzzle, PuzzleHash, Sha256tree, Timeout};
use crate::common::standard_coin::{ChiaIdentity, read_hex_puzzle};
use crate::referee::types::{GameMoveDetails, GameMoveStateInfo, RefereePuzzleArgs};

pub struct DebugGameCurry {
    count: usize,
    self_hash: PuzzleHash,
    self_prog: Rc<Program>,
    mover0: PuzzleHash,
    waiter0: PuzzleHash,
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for DebugGameCurry
where
    NodePtr: ToClvm<E>
{
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        (
            self.count,
            (
                self.self_hash.clone(),
                (
                    self.self_prog.clone(),
                    (
                        self.mover0.clone(),
                        (
                            (self.waiter0.clone(), ())
                        )
                    )
                )
            )
        ).to_clvm(encoder)
    }
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

    validation_program_queue: VecDeque<StateUpdateProgram>,

    handler: GameHandler,
    start: GameStartInfo,
}

impl BareDebugGameDriver {
    fn new(
        allocator: &mut AllocEncoder,
        game_id: GameID,
        amount: Amount,
        identities: &[ChiaIdentity],
        referee_coin_puzzle_hash: &PuzzleHash,
        game_hex_file: &str,
    ) -> Result<[BareDebugGameDriver; 2], Error> {
        let raw_program = read_hex_puzzle(allocator, game_hex_file)?;
        let prog_hash = raw_program.sha256tree(allocator);
        let args = DebugGameCurry {
            count: 0,
            self_prog: raw_program.to_program(),
            self_hash: prog_hash,
            mover0: identities[0].puzzle_hash.clone(),
            waiter0: identities[1].puzzle_hash.clone()
        };
        let curried = CurriedProgram {
            program: raw_program.to_clvm(allocator).into_gen()?,
            args: clvm_curried_args!("factory", args)
        }.to_clvm(allocator).into_gen()?;
        let curried_prog = Program::from_nodeptr(allocator, curried)?;
        let alice_game = Game::new_program(allocator, true, game_id.clone(), curried_prog.clone().into())?;
        let bob_game = Game::new_program(allocator, false, game_id.clone(), curried_prog.into())?;
        let (start_a, start_b) = alice_game.symmetric_game_starts(
            &game_id,
            &Amount::new(100),
            &Amount::new(100),
            &Timeout::new(10)
        );
        let alice_driver = BareDebugGameDriver {
            i_am_alice: true,
            move_count: 0,
            alice_identity: identities[0].clone(),
            bob_identity: identities[1].clone(),
            game_id: game_id.clone(),
            handler: start_a.game_handler.clone(),
            start: start_a,
            validation_program_queue: VecDeque::default(),
            game: alice_game.clone(),
        };
        let bob_driver = BareDebugGameDriver {
            i_am_alice: false,
            move_count: 0,
            alice_identity: identities[0].clone(),
            bob_identity: identities[1].clone(),
            game_id: game_id.clone(),
            handler: start_b.game_handler.clone(),
            start: start_b,
            validation_program_queue: VecDeque::default(),
            game: bob_game,
        };
        Ok([alice_driver, bob_driver])
    }
}

fn make_debug_games(allocator: &mut AllocEncoder) -> Result<[BareDebugGameDriver; 2], Error> {
    let rng_seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(rng_seed);
    let pk0: PrivateKey = rng.gen();
    let pk1: PrivateKey = rng.gen();
    let id0 = ChiaIdentity::new(allocator, pk0)?;
    let id1 = ChiaIdentity::new(allocator, pk1)?;
    let identities: [ChiaIdentity; 2] = [id0, id1];
    let gid = GameID::default();
    let referee_coin = read_hex_puzzle(
        allocator, "clsp/onchain/referee.hex"
    )?;
    let ref_coin_hash = referee_coin.sha256tree(allocator);
    BareDebugGameDriver::new(
        allocator,
        gid,
        Amount::new(200),
        &identities,
        &ref_coin_hash,
        "clsp/test/debug_game.hex",
    )
}

#[test]
fn test_debug_game_factory() {
    let mut allocator = AllocEncoder::new();
    let debug_games = make_debug_games(&mut allocator).expect("good");
    todo!();
}
