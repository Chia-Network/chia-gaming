use std::collections::VecDeque;
use std::rc::Rc;

use rand::prelude::*;
use rand_chacha::ChaCha8Rng;

use log::debug;

use clvmr::{run_program, NodePtr};

use clvm_traits::{clvm_curried_args, ClvmEncoder, ToClvm, ToClvmError};
use clvm_utils::CurriedProgram;

use crate::channel_handler::game::Game;
use crate::channel_handler::game_handler::{GameHandler, MyTurnInputs};
use crate::channel_handler::types::{
    Evidence, GameStartInfo, HasStateUpdateProgram, ReadableMove, StateUpdateProgram,
    ValidationInfo,
};
use crate::common::standard_coin::{read_hex_puzzle, ChiaIdentity};
use crate::common::types::{
    atom_from_clvm, chia_dialect, AllocEncoder, Amount, Error, GameID, Hash, IntoErr, Node,
    PrivateKey, Program, ProgramRef, Puzzle, PuzzleHash, Sha256tree, Timeout,
};
use crate::referee::types::{
    tmpsave, GameMoveDetails, GameMoveStateInfo, InternalStateUpdateArgs, RefereePuzzleArgs,
    StateUpdateMoveArgs, StateUpdateResult,
};

pub struct DebugGameCurry {
    count: usize,
    self_hash: PuzzleHash,
    self_prog: Rc<Program>,
    mover0: PuzzleHash,
    waiter0: PuzzleHash,
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for DebugGameCurry
where
    NodePtr: ToClvm<E>,
{
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        (
            self.count,
            (
                self.self_hash.clone(),
                (
                    self.self_prog.clone(),
                    (self.mover0.clone(), ((self.waiter0.clone(), ()))),
                ),
            ),
        )
            .to_clvm(encoder)
    }
}

/// A driver for the bare debug game, wrapped in a referee coin.
pub struct BareDebugGameDriver {
    game: Game,

    alice_identity: ChiaIdentity,
    bob_identity: ChiaIdentity,

    i_am_alice: bool,

    move_count: usize,
    mod_hash: PuzzleHash,
    nonce: usize,
    timeout: Timeout,

    // Live
    max_move_size: usize,
    mover_share: VecDeque<Amount>,
    state: ProgramRef,
    last_validation_data: Option<(StateUpdateProgram, ProgramRef)>,

    validation_program_queue: VecDeque<StateUpdateProgram>,

    #[allow(dead_code)]
    handler: GameHandler,
    start: GameStartInfo,
    rng: Vec<Hash>,
}

impl BareDebugGameDriver {
    fn get_previous_validation_info_hash(
        &self,
        allocator: &mut AllocEncoder,
    ) -> Option<ValidationInfo<ProgramRef>> {
        self.last_validation_data
            .as_ref()
            .map(|(sp, st)| ValidationInfo::new(allocator, sp.clone(), st.clone()))
    }

    fn new(
        allocator: &mut AllocEncoder,
        game_id: GameID,
        nonce: usize,
        identities: &[ChiaIdentity],
        referee_coin_puzzle_hash: &PuzzleHash,
        timeout: Timeout,
        rng_sequence: &[Hash],
        game_hex_file: &str,
    ) -> Result<[BareDebugGameDriver; 2], Error> {
        let raw_program = read_hex_puzzle(allocator, game_hex_file)?;
        let prog_hash = raw_program.sha256tree(allocator);
        let args = DebugGameCurry {
            count: 0,
            self_prog: raw_program.to_program(),
            self_hash: prog_hash,
            mover0: identities[0].puzzle_hash.clone(),
            waiter0: identities[1].puzzle_hash.clone(),
        };
        let curried = CurriedProgram {
            program: raw_program.to_clvm(allocator).into_gen()?,
            args: clvm_curried_args!("factory", args),
        }
        .to_clvm(allocator)
        .into_gen()?;
        let curried_prog = Program::from_nodeptr(allocator, curried)?;
        let alice_game = Game::new_program(
            allocator,
            true,
            game_id.clone(),
            curried_prog.clone().into(),
        )?;
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
            handler: start_a.game_handler.clone(),
            timeout: timeout.clone(),
            max_move_size: start_a.initial_max_move_size,
            mover_share: [start_a.initial_mover_share.clone()].into_iter().collect(),
            state: start_a.initial_state.clone(),
            validation_program_queue: [start_a.initial_validation_program.clone()]
                .iter()
                .cloned()
                .collect(),
            start: start_a,
            last_validation_data: None,
            mod_hash: referee_coin_puzzle_hash.clone(),
            nonce,
            game: alice_game.clone(),
            rng: rng_sequence
                .iter()
                .take(rng_sequence.len() / 2)
                .cloned()
                .collect(),
        };
        let bob_driver = BareDebugGameDriver {
            i_am_alice: false,
            move_count: 0,
            alice_identity: identities[0].clone(),
            bob_identity: identities[1].clone(),
            handler: start_b.game_handler.clone(),
            timeout,
            max_move_size: start_b.initial_max_move_size,
            mover_share: [start_b.initial_mover_share.clone()].into_iter().collect(),
            state: start_b.initial_state.clone(),
            validation_program_queue: [start_b.initial_validation_program.clone()]
                .iter()
                .cloned()
                .collect(),
            start: start_b,
            last_validation_data: None,
            mod_hash: referee_coin_puzzle_hash.clone(),
            nonce,
            game: bob_game,
            rng: rng_sequence
                .iter()
                .skip(rng_sequence.len() / 2)
                .cloned()
                .collect(),
        };
        Ok([alice_driver, bob_driver])
    }

    pub fn alice_turn(&self) -> bool {
        self.i_am_alice ^ ((self.move_count & 1) == 0)
    }

    pub fn get_mover_and_waiter_ph(&self) -> (PuzzleHash, PuzzleHash, Puzzle) {
        let mover_ph = if self.alice_turn() {
            &self.alice_identity.puzzle_hash
        } else {
            &self.bob_identity.puzzle_hash
        };
        let mover_puzzle = if self.alice_turn() {
            self.alice_identity.puzzle.clone()
        } else {
            self.bob_identity.puzzle.clone()
        };
        let waiter_ph = if self.alice_turn() {
            &self.bob_identity.puzzle_hash
        } else {
            &self.alice_identity.puzzle_hash
        };

        (mover_ph.clone(), waiter_ph.clone(), mover_puzzle)
    }

    pub fn end_my_turn(
        &mut self,
        allocator: &mut AllocEncoder,
        exhaustive_inputs: &ExhaustiveMoveInputs,
    ) -> Result<(), Error> {
        assert!(self.i_am_alice == ((self.move_count & 1) == 0));

        let move_data = exhaustive_inputs
            .to_linear_move(allocator, true)
            .expect("good");

        let ui_move = exhaustive_inputs.get_ui_move(allocator)?;
        debug!("my turn handler {:?}", self.handler);
        let my_handler_result = self.handler.call_my_turn_driver(
            allocator,
            &MyTurnInputs {
                readable_new_move: ui_move,
                entropy: self.rng[self.move_count].clone(),
                amount: self.start.amount.clone(),
                last_mover_share: self.mover_share.pop_front().unwrap(),
            },
        )?;

        self.validation_program_queue.clear();
        self.validation_program_queue
            .push_back(my_handler_result.outgoing_move_state_update_program.p());
        self.validation_program_queue
            .push_back(my_handler_result.incoming_move_state_update_program.p());
        self.mover_share.push_back(my_handler_result.mover_share.clone());

        let vprog = if let Some(v) = self.validation_program_queue.pop_front() {
            v
        } else {
            return Err(Error::StrErr(
                "No waiting validation program for our turn".to_string(),
            ));
        };

        let p_validation_hash = exhaustive_inputs.previous_validation_info_hash(allocator)?;
        let state_update_result = self.generic_run_state_update(
            allocator,
            vprog.clone(),
            p_validation_hash,
            &move_data,
            Evidence::nil()?,
        )?;

        assert_eq!(my_handler_result.move_bytes, move_data);

        self.move_count += 1;

        if let StateUpdateResult::MoveOk(new_state, _new_validation_info_hash, new_max_move_size) =
            state_update_result
        {
            self.max_move_size = new_max_move_size;
            self.state = ProgramRef::new(new_state.clone());
            self.last_validation_data = Some((vprog.clone(), self.state.clone()));
        }

        Ok(())
    }

    pub fn generic_run_state_update(
        &self,
        allocator: &mut AllocEncoder,
        validation_program: StateUpdateProgram,
        previous_validation_info_hash: Option<Hash>,
        move_to_check: &[u8],
        evidence: Evidence,
    ) -> Result<StateUpdateResult, Error> {
        let (mover_ph, waiter_ph, mover_puzzle) = self.get_mover_and_waiter_ph();

        tmpsave("v-prog.hex", &validation_program.to_program().to_hex());

        let update_args = InternalStateUpdateArgs {
            referee_args: Rc::new(
                RefereePuzzleArgs {
                    nonce: self.nonce,
                    previous_validation_info_hash,
                    referee_coin_puzzle_hash: self.mod_hash.clone(),
                    timeout: self.timeout.clone(),
                    mover_puzzle_hash: mover_ph.clone(),
                    waiter_puzzle_hash: waiter_ph.clone(),
                    amount: self.start.amount.clone(),
                    game_move: GameMoveDetails {
                        basic: GameMoveStateInfo {
                            move_made: move_to_check.to_vec(),
                            mover_share: self.mover_share[0].clone(),
                        },
                        validation_info_hash: ValidationInfo::new(
                            allocator,
                            validation_program.clone(),
                            self.state.clone(),
                        )
                        .hash()
                        .clone(),
                    },
                    max_move_size: self.max_move_size,
                }
                .off_chain(),
            ),
            state_update_args: StateUpdateMoveArgs {
                evidence: evidence.to_program(),
                mover_puzzle: mover_puzzle.to_program(),
                solution: Rc::new(Program::from_hex("80")?),
                state: self.state.p(),
            },
            validation_program: validation_program,
        };

        update_args.run(allocator)
    }

    pub fn get_move_inputs(&self, allocator: &mut AllocEncoder) -> ExhaustiveMoveInputs {
        assert!(self.validation_program_queue.len() > 0);
        let validation_info = ValidationInfo::new(
            allocator,
            self.validation_program_queue[0].clone().into(),
            self.state.clone(),
        );
        ExhaustiveMoveInputs {
            alice: self.alice_turn(),
            alice_puzzle_hash: self.alice_identity.puzzle_hash.clone(),
            bob_puzzle_hash: self.bob_identity.puzzle_hash.clone(),
            amount: self.start.amount.clone(),
            count: self.move_count,
            max_move_size: self.max_move_size,
            mod_hash: self.mod_hash.clone(),
            mover_share: self.mover_share[0].clone(),
            nonce: self.nonce,
            timeout: self.timeout.clone(),
            validation_program: self.validation_program_queue[0].clone(),
            validation_info: validation_info,
            incoming_state_validation_info_hash: self
                .get_previous_validation_info_hash(allocator)
                .map(|v| v.hash().clone()),
            slash: 15,
            opponent_mover_share: Amount::new(0xfff),
            previous_validation_info: self.last_validation_data.clone(),
            entropy: self.rng[self.move_count].clone(),
        }
    }

    pub fn state_update_for_own_move(
        &mut self,
        allocator: &mut AllocEncoder,
        move_to_check: &[u8],
        evidence: Evidence,
    ) -> Result<StateUpdateResult, Error> {
        let vprog = if let Some(v) = self.validation_program_queue.pop_front() {
            v
        } else {
            return Err(Error::StrErr(
                "No waiting validation program for our turn".to_string(),
            ));
        };

        let previous_validation_info_hash = self
            .get_previous_validation_info_hash(allocator)
            .map(|v| v.hash().clone());

        self.generic_run_state_update(
            allocator,
            vprog,
            previous_validation_info_hash,
            move_to_check,
            evidence,
        )
    }

    pub fn accept_move(
        &mut self,
        _allocator: &mut AllocEncoder,
        _inputs: &ExhaustiveMoveInputs,
    ) -> Result<(), Error> {
        todo!();
    }
}

fn make_debug_games(allocator: &mut AllocEncoder) -> Result<[BareDebugGameDriver; 2], Error> {
    let rng_seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(rng_seed);
    let pk0: PrivateKey = rng.gen();
    let pk1: PrivateKey = rng.gen();
    let rng_seq0: Vec<Hash> = (0..50).map(|_| rng.gen()).collect();
    let id0 = ChiaIdentity::new(allocator, pk0)?;
    let id1 = ChiaIdentity::new(allocator, pk1)?;
    let identities: [ChiaIdentity; 2] = [id0, id1];
    let gid = GameID::default();
    let referee_coin = read_hex_puzzle(allocator, "clsp/referee/onchain/referee-v1.hex")?;
    let ref_coin_hash = referee_coin.sha256tree(allocator);
    BareDebugGameDriver::new(
        allocator,
        gid,
        0,
        &identities,
        &ref_coin_hash,
        Timeout::new(10),
        &rng_seq0,
        "clsp/test/debug_game.hex",
    )
}

#[test]
fn test_debug_game_factory() {
    let mut allocator = AllocEncoder::new();
    let debug_games = make_debug_games(&mut allocator).expect("good");
    assert_eq!(512, debug_games[0].game.initial_max_move_size);
    assert_eq!(
        debug_games[0].game.initial_max_move_size,
        debug_games[1].game.initial_max_move_size
    );
}

pub struct ExhaustiveMoveInputs {
    alice: bool,
    alice_puzzle_hash: PuzzleHash,
    bob_puzzle_hash: PuzzleHash,
    mod_hash: PuzzleHash,
    validation_info: ValidationInfo<ProgramRef>,
    validation_program: StateUpdateProgram,
    incoming_state_validation_info_hash: Option<Hash>,
    timeout: Timeout,
    amount: Amount,
    max_move_size: usize,
    mover_share: Amount,
    count: usize,
    nonce: usize,
    #[allow(dead_code)]
    entropy: Hash,
    slash: u8,
    opponent_mover_share: Amount,
    previous_validation_info: Option<(StateUpdateProgram, ProgramRef)>
}

fn at_least_one_byte(allocator: &mut AllocEncoder, amt: &Amount) -> Result<NodePtr, Error> {
    if amt == &Amount::default() {
        allocator
            .encode_atom(clvm_traits::Atom::Borrowed(&[0]))
            .into_gen()
    } else {
        amt.to_clvm(allocator).into_gen()
    }
}

impl ExhaustiveMoveInputs {
    pub fn slash_atom(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        allocator
            .encode_atom(clvm_traits::Atom::Borrowed(&[self.slash]))
            .into_gen()
    }

    pub fn get_ui_move(&self, allocator: &mut AllocEncoder) -> Result<ReadableMove, Error> {
        let slash_node = self.slash_atom(allocator)?;
        let linear_move = self.to_linear_move(allocator, true)?;
        let move_tail = self.move_tail(allocator)?;
        let linear_move_node = allocator
            .encode_atom(clvm_traits::Atom::Borrowed(&linear_move[0..(linear_move.len() - move_tail.len())]))
            .into_gen()?;
        let readable_move = (
            Node(linear_move_node),
            (
                self.count,
                (self.opponent_mover_share.clone(), (Node(slash_node), ())),
            ),
        )
            .to_clvm(allocator)
            .into_gen()?;
        ReadableMove::from_nodeptr(allocator, readable_move)
    }

    pub fn move_tail(&self, allocator: &mut AllocEncoder) -> Result<Vec<u8>, Error> {
        let slash_atom = self.slash_atom(allocator)?;
        let count_atom = at_least_one_byte(allocator, &Amount::new(self.count as u64))?;
        let amount_atom = at_least_one_byte(allocator, &self.opponent_mover_share)?;
        let args = (
            Node(count_atom),
            (
                Node(amount_atom),
                ((Node(slash_atom), ())),
            ),
        ).to_clvm(allocator).into_gen()?;
        let program_to_concat = Program::from_hex("ff0eff02ff05ff0b80")?;
        let pnode = program_to_concat.to_clvm(allocator).into_gen()?;
        let result_atom = run_program(allocator.allocator(), &chia_dialect(), pnode, args, 0)
            .into_gen()?
            .1;
        if let Some(result_move_data) = atom_from_clvm(allocator, result_atom) {
            Ok(result_move_data)
        } else {
            Err(Error::StrErr("move didn't concat".to_string()))
        }
    }

    pub fn to_linear_move(
        &self,
        allocator: &mut AllocEncoder,
        off_chain: bool,
    ) -> Result<Vec<u8>, Error> {
        let mover_ph_ref = if self.alice {
            &self.alice_puzzle_hash
        } else {
            &self.bob_puzzle_hash
        };
        let waiter_ph_ref = if off_chain {
            None
        } else if self.alice {
            Some(&self.bob_puzzle_hash)
        } else {
            Some(&self.alice_puzzle_hash)
        };
        let pv_hash = self.validation_program.sha256tree(allocator);
        let count_atom = at_least_one_byte(allocator, &Amount::new(self.count as u64))?;
        let slash_atom = self.slash_atom(allocator)?;
        let amount_atom = at_least_one_byte(allocator, &self.opponent_mover_share)?;
        let args = (
            mover_ph_ref.clone(),
            (
                waiter_ph_ref.cloned(),
                (
                    self.mod_hash.clone(),
                    (
                        self.validation_info.hash(),
                        (
                            self.incoming_state_validation_info_hash.clone(),
                            (
                                pv_hash,
                                (
                                    self.timeout.clone(),
                                    (
                                        self.amount.clone(),
                                        (
                                            self.nonce,
                                            (
                                                self.max_move_size,
                                                (
                                                    self.mover_share.clone(),
                                                    (
                                                        Node(count_atom),
                                                        (
                                                            Node(amount_atom),
                                                            ((Node(slash_atom), ())),
                                                        ),
                                                    ),
                                                ),
                                            ),
                                        ),
                                    ),
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        )
            .to_clvm(allocator)
            .into_gen()?;

        let program_to_concat = Program::from_hex("ff0eff02ff05ff0bff17ff2fff5fff8200bfff82017fff8202ffff8205ffff820bffff8217ffff822fffff825fff80")?;
        let pnode = program_to_concat.to_clvm(allocator).into_gen()?;
        let result_atom = run_program(allocator.allocator(), &chia_dialect(), pnode, args, 0)
            .into_gen()?
            .1;
        if let Some(result_move_data) = atom_from_clvm(allocator, result_atom) {
            debug!("generated move data {result_move_data:?}");
            Ok(result_move_data)
        } else {
            Err(Error::StrErr("move didn't concat".to_string()))
        }
    }

    pub fn previous_validation_info_hash(
        &self,
        allocator: &mut AllocEncoder,
    ) -> Result<Option<Hash>, Error> {
        if let Some((vprog, vstate)) = self.previous_validation_info.as_ref() {
            let validation_info = ValidationInfo::new(
                allocator,
                vprog.clone(),
                vstate.clone()
            );
            Ok(Some(validation_info.hash().clone()))
        } else {
            Ok(None)
        }
    }
}

#[test]
fn test_debug_game_validation_move() {
    let mut allocator = AllocEncoder::new();
    let mut debug_games = make_debug_games(&mut allocator).expect("good");
    assert_eq!(
        debug_games[0].game.initial_validation_program,
        debug_games[1].game.initial_validation_program
    );
    // Predict the first move bytes.
    let predicted_move = debug_games[0].get_move_inputs(&mut allocator);
    let move_data = predicted_move
        .to_linear_move(&mut allocator, true)
        .expect("good");
    debug!("move_data {move_data:?}");
    let validation_result = debug_games[0]
        .state_update_for_own_move(&mut allocator, &move_data, Evidence::nil().expect("good"))
        .expect("good");
    debug!("validation_result {validation_result:?}");
    assert!(matches!(
        validation_result,
        StateUpdateResult::MoveOk(_, _, 512)
    ));
    debug!("end my turn");
    debug_games[0]
        .end_my_turn(&mut allocator, &predicted_move)
        .expect("good");
    debug!("accept move");
    debug_games[1]
        .accept_move(&mut allocator, &predicted_move)
        .expect("good");
    let predicted_bob_move = debug_games[1].get_move_inputs(&mut allocator);
    let _bob_move_data = predicted_bob_move
        .to_linear_move(&mut allocator, true)
        .expect("good");
}
