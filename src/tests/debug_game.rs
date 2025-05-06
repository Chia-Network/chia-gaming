use std::rc::Rc;
use std::collections::VecDeque;

use rand_chacha::ChaCha8Rng;
use rand::prelude::*;

use log::debug;

use clvmr::{NodePtr, run_program};

use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError, clvm_curried_args};
use clvm_utils::CurriedProgram;

use crate::channel_handler::game::Game;
use crate::channel_handler::game_handler::GameHandler;
use crate::channel_handler::types::{GameStartInfo, StateUpdateProgram, ValidationInfo};
use crate::common::types::{AllocEncoder, Amount, Error, GameID, Hash, IntoErr, Node, PrivateKey, Program, ProgramRef, Puzzle, PuzzleHash, Sha256tree, Timeout, atom_from_clvm, chia_dialect};
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
    mod_hash: PuzzleHash,
    nonce: usize,
    timeout: Timeout,

    // Live
    max_move_size: usize,
    mover_share: Amount,
    move_made: Vec<u8>,
    state: ProgramRef,
    last_validation_info_hash: Option<Hash>,

    validation_program_queue: VecDeque<StateUpdateProgram>,

    handler: GameHandler,
    start: GameStartInfo,
}

impl BareDebugGameDriver {
    fn new(
        allocator: &mut AllocEncoder,
        game_id: GameID,
        nonce: usize,
        identities: &[ChiaIdentity],
        referee_coin_puzzle_hash: &PuzzleHash,
        timeout: Timeout,
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
            &timeout,
        );
        let alice_driver = BareDebugGameDriver {
            i_am_alice: true,
            move_count: 0,
            alice_identity: identities[0].clone(),
            bob_identity: identities[1].clone(),
            game_id: game_id.clone(),
            handler: start_a.game_handler.clone(),
            timeout: timeout.clone(),
            max_move_size: start_a.initial_max_move_size,
            move_made: start_a.initial_move.clone(),
            mover_share: start_a.initial_mover_share.clone(),
            state: start_a.initial_state.clone(),
            validation_program_queue: [start_a.initial_validation_program.clone()].iter().cloned().collect(),
            start: start_a,
            last_validation_info_hash: None,
            mod_hash: referee_coin_puzzle_hash.clone(),
            nonce,
            game: alice_game.clone(),
        };
        let bob_driver = BareDebugGameDriver {
            i_am_alice: false,
            move_count: 0,
            alice_identity: identities[0].clone(),
            bob_identity: identities[1].clone(),
            game_id: game_id.clone(),
            handler: start_b.game_handler.clone(),
            timeout,
            max_move_size: start_b.initial_max_move_size,
            move_made: start_b.initial_move.clone(),
            mover_share: start_b.initial_mover_share.clone(),
            state: start_b.initial_state.clone(),
            validation_program_queue: [start_b.initial_validation_program.clone()].iter().cloned().collect(),
            start: start_b,
            last_validation_info_hash: None,
            mod_hash: referee_coin_puzzle_hash.clone(),
            nonce,
            game: bob_game,
        };
        Ok([alice_driver, bob_driver])
    }

    pub fn get_move_inputs(&self, allocator: &mut AllocEncoder) -> ExhaustiveMoveInputs {
        assert!(self.validation_program_queue.len() > 0);
        let validation_info = ValidationInfo::new(
            allocator,
            self.validation_program_queue[0].clone().into(),
            self.state.clone(),
        );
        ExhaustiveMoveInputs {
            alice: self.i_am_alice ^ ((self.move_count & 1) == 0),
            alice_puzzle_hash: self.alice_identity.puzzle_hash.clone(),
            bob_puzzle_hash: self.bob_identity.puzzle_hash.clone(),
            amount: self.start.amount.clone(),
            count: self.move_count,
            max_move_size: self.max_move_size,
            mod_hash: self.mod_hash.clone(),
            move_made: self.move_made.clone(),
            mover_share: self.mover_share.clone(),
            nonce: self.nonce,
            timeout: self.timeout.clone(),
            validation_info: validation_info,
            incoming_state_validation_info_hash: self.last_validation_info_hash.clone()
        }
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
        0,
        &identities,
        &ref_coin_hash,
        Timeout::new(10),
        "clsp/test/debug_game.hex",
    )
}

#[test]
fn test_debug_game_factory() {
    let mut allocator = AllocEncoder::new();
    let debug_games = make_debug_games(&mut allocator).expect("good");
    assert_eq!(256, debug_games[0].game.initial_max_move_size);
    assert_eq!(debug_games[0].game.initial_max_move_size, debug_games[1].game.initial_max_move_size);
}

struct ExhaustiveMoveInputs {
    alice: bool,
    alice_puzzle_hash: PuzzleHash,
    bob_puzzle_hash: PuzzleHash,
    mod_hash: PuzzleHash,
    validation_info: ValidationInfo<ProgramRef>,
    incoming_state_validation_info_hash: Option<Hash>,
    timeout: Timeout,
    amount: Amount,
    max_move_size: usize,
    mover_share: Amount,
    count: usize,
    nonce: usize,
    move_made: Vec<u8>,
}

impl ExhaustiveMoveInputs {
    fn to_linear_move(
        &self,
        allocator: &mut AllocEncoder,
        off_chain: bool,
    ) -> Result<Vec<u8>, Error> {
        let mut result_vec: Vec<u8> = Vec::default();
        let mover_ph_ref =
            if self.alice {
                &self.alice_puzzle_hash
            } else {
                &self.bob_puzzle_hash
            };
        let waiter_ph_ref =
            if off_chain {
                None
            } else if self.alice {
                Some(&self.bob_puzzle_hash)
            } else {
                Some(&self.alice_puzzle_hash)
            };

        let move_atom = allocator.encode_atom(clvm_traits::Atom::Borrowed(&self.move_made)).into_gen()?;
        let args = (
            mover_ph_ref.clone(),
            (
                waiter_ph_ref.cloned(),
                (
                    self.timeout.clone(),
                    (
                        self.amount.clone(),
                        (
                            self.mod_hash.clone(),
                            (
                                self.nonce,
                                (
                                    Node(move_atom),
                                    (
                                        self.max_move_size,
                                        (
                                            self.validation_info.hash(),
                                            (
                                                self.mover_share.clone(),
                                                (
                                                    (self.incoming_state_validation_info_hash.clone(), ())
                                                )
                                            )
                                        )
                                    )
                                )
                            )
                        )
                    )
                )
            )
        ).to_clvm(allocator).into_gen()?;

        let program_to_concat = Program::from_hex("ff0eff02ff05ff0bff17ff2fff5fff8200bfff82017fff8202ffff8205ffff820bff80")?;
        let pnode = program_to_concat.to_clvm(allocator).into_gen()?;
        let result_atom = run_program(
            allocator.allocator(),
            &chia_dialect(),
            pnode,
            args,
            0
        ).into_gen()?.1;
        if let Some(result_move_data) = atom_from_clvm(allocator, result_atom) {
            Ok(result_move_data)
        } else {
            Err(Error::StrErr("move didn't concat".to_string()))
        }
    }
}

#[test]
fn test_debug_game_validation_move() {
    let mut allocator = AllocEncoder::new();
    let debug_games = make_debug_games(&mut allocator).expect("good");
    assert_eq!(debug_games[0].game.initial_validation_program, debug_games[1].game.initial_validation_program);
    // Predict the first move bytes.
    let predicted_move = debug_games[0].get_move_inputs(&mut allocator);
    let move_data = predicted_move.to_linear_move(&mut allocator, false).expect("good");
    debug!("move_data {move_data:?}");
    todo!();
}
