use std::collections::VecDeque;
use std::rc::Rc;

use rand::prelude::*;
use rand_chacha::ChaCha8Rng;

use log::debug;

use clvmr::{run_program, NodePtr};

use clvm_traits::{clvm_curried_args, ClvmEncoder, ToClvm, ToClvmError};
use clvm_utils::CurriedProgram;

use crate::channel_handler::game_handler::TheirTurnResult;
use crate::channel_handler::types::{
    Evidence, HasStateUpdateProgram, ReadableMove, StateUpdateProgram, ValidationInfo,
};
use crate::channel_handler::v1::game::Game;
use crate::channel_handler::v1::game_handler::{GameHandler, MyTurnInputs, TheirTurnInputs};
use crate::channel_handler::v1::game_start_info::GameStartInfo;
use crate::common::standard_coin::{read_hex_puzzle, ChiaIdentity};
use crate::common::types::{
    atom_from_clvm, chia_dialect, AllocEncoder, Amount, Error, GameID, Hash, IntoErr, Node,
    PrivateKey, Program, ProgramRef, Puzzle, PuzzleHash, Sha256tree, Timeout,
};
use crate::referee::types::{GameMoveDetails, GameMoveStateInfo};
use crate::referee::v1::types::{
    InternalStateUpdateArgs, RefereePuzzleArgs, StateUpdateMoveArgs, StateUpdateResult,
};
use crate::utils::pair_of_array_mut;

#[derive(Debug)]
pub struct DebugGameCurry {
    pub count: usize,
    pub self_hash: PuzzleHash,
    pub self_prog: Rc<Program>,
    pub mover0: PuzzleHash,
    pub waiter0: PuzzleHash,
}

impl DebugGameCurry {
    pub fn new(
        allocator: &mut AllocEncoder,
        mover_ph: &PuzzleHash,
        waiter_ph: &PuzzleHash,
    ) -> Result<DebugGameCurry, Error> {
        let raw_program = read_hex_puzzle(allocator, "clsp/test/debug_game.hex")?;
        let prog_hash = raw_program.sha256tree(allocator);
        Ok(DebugGameCurry {
            count: 0,
            self_prog: raw_program.to_program(),
            self_hash: prog_hash,
            mover0: mover_ph.clone(),
            waiter0: waiter_ph.clone(),
        })
    }
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

pub struct DebugGameMoveInfo {
    #[allow(dead_code)]
    pub ui_move: ReadableMove,
    #[allow(dead_code)]
    pub move_data: Vec<u8>,
    #[allow(dead_code)]
    pub slash: Option<Rc<Program>>,
}

/// A driver for the bare debug game, wrapped in a referee coin.
pub struct BareDebugGameDriver {
    game: Game,

    pub alice_identity: ChiaIdentity,
    pub bob_identity: ChiaIdentity,

    i_am_alice: bool,

    move_count: usize,
    mod_hash: PuzzleHash,
    nonce: usize,
    timeout: Timeout,

    // Live
    max_move_size: usize,
    mover_share: Amount,
    next_mover_share: Amount,
    state: ProgramRef,
    last_validation_data: Option<(StateUpdateProgram, ProgramRef)>,

    validation_program_queue: VecDeque<StateUpdateProgram>,

    #[allow(dead_code)]
    handler: GameHandler,
    next_handler: GameHandler,
    start: GameStartInfo,
    rng: Vec<Hash>,

    slash_detected: Option<Evidence>,
}

impl BareDebugGameDriver {
    fn get_previous_validation_info_hash(
        &self,
        allocator: &mut AllocEncoder,
    ) -> Option<ValidationInfo> {
        self.last_validation_data
            .as_ref()
            .map(|(sp, st)| ValidationInfo::new_state_update(allocator, sp.clone(), st.p()))
    }

    fn new(
        allocator: &mut AllocEncoder,
        game_id: GameID,
        nonce: usize,
        identities: &[ChiaIdentity],
        referee_coin_puzzle_hash: &PuzzleHash,
        timeout: Timeout,
        rng_sequence: &[Hash],
    ) -> Result<[BareDebugGameDriver; 2], Error> {
        let args = DebugGameCurry::new(
            allocator,
            &identities[0].puzzle_hash,
            &identities[1].puzzle_hash,
        )?;
        debug!("curried args into game {args:?}");

        let curried = CurriedProgram {
            program: args.self_prog.to_clvm(allocator).into_gen()?,
            args: clvm_curried_args!("factory", ()),
        }
        .to_clvm(allocator)
        .into_gen()?;
        let curried_prog = Program::from_nodeptr(allocator, curried)?;
        let args_node = (100, (100, (args, ()))).to_clvm(allocator).into_gen()?;
        let args_clvm = Rc::new(Program::from_nodeptr(allocator, args_node)?);
        let alice_game = Game::new_program(
            allocator,
            true,
            &game_id,
            curried_prog.clone().into(),
            args_clvm.clone(),
        )?;
        let bob_game =
            Game::new_program(allocator, false, &game_id, curried_prog.into(), args_clvm)?;
        let start_a =
            alice_game.game_start(&game_id, &Amount::new(100), &Amount::new(100), &timeout);
        let start_b = bob_game.game_start(&game_id, &Amount::new(100), &Amount::new(100), &timeout);
        assert_ne!(start_a.amount, Amount::default());
        assert_ne!(start_b.amount, Amount::default());
        let alice_driver = BareDebugGameDriver {
            i_am_alice: true,
            move_count: 0,
            alice_identity: identities[0].clone(),
            bob_identity: identities[1].clone(),
            handler: start_a.game_handler.clone(),
            next_handler: start_a.game_handler.clone(),
            timeout: timeout.clone(),
            max_move_size: start_a.initial_max_move_size,
            next_mover_share: start_a.initial_mover_share.clone(),
            mover_share: start_a.initial_mover_share.clone(),
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
            slash_detected: None,
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
            next_handler: start_b.game_handler.clone(),
            timeout,
            max_move_size: start_b.initial_max_move_size,
            next_mover_share: start_b.initial_mover_share.clone(),
            mover_share: start_b.initial_mover_share.clone(),
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
            slash_detected: None,
            rng: rng_sequence
                .iter()
                .skip(rng_sequence.len() / 2)
                .cloned()
                .collect(),
        };
        debug!("created a mover share {:?}", alice_driver.mover_share);
        debug!("created b mover share {:?}", bob_driver.mover_share);
        Ok([alice_driver, bob_driver])
    }

    pub fn alice_turn(&self) -> bool {
        (self.move_count & 1) == 0
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

    pub fn prime_my_turn(
        &mut self,
        allocator: &mut AllocEncoder,
        exhaustive_inputs: &ExhaustiveMoveInputs,
    ) -> Result<(), Error> {
        let ui_move = exhaustive_inputs.get_ui_move(allocator)?;
        debug!("my turn handler {:?}", self.handler);
        let my_handler_result = self.handler.call_my_turn_driver(
            allocator,
            &MyTurnInputs {
                readable_new_move: ui_move,
                entropy: self.rng[self.move_count].clone(),
                amount: self.start.amount.clone(),
                last_mover_share: self.mover_share.clone(),
            },
        )?;

        let move_data = exhaustive_inputs
            .to_linear_move(allocator, true)
            .expect("good");

        assert_eq!(my_handler_result.move_bytes, move_data);

        self.next_handler = my_handler_result.waiting_driver.clone();
        self.validation_program_queue.clear();
        self.validation_program_queue
            .push_back(my_handler_result.outgoing_move_state_update_program.p());
        self.validation_program_queue
            .push_back(my_handler_result.incoming_move_state_update_program.p());
        self.next_mover_share = my_handler_result.mover_share.clone();

        Ok(())
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

        if let StateUpdateResult::MoveOk(new_state, _new_validation_info_hash, new_max_move_size) =
            state_update_result
        {
            self.handler = self.next_handler.clone();
            self.move_count += 1;
            self.mover_share = self.next_mover_share.clone();
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

        // tmpsave("v-prog.hex", &validation_program.to_program().to_hex());

        let update_args = InternalStateUpdateArgs {
            referee_args: Rc::new(
                RefereePuzzleArgs {
                    nonce: self.nonce,
                    validation_program: validation_program.clone(),
                    previous_validation_info_hash,
                    referee_coin_puzzle_hash: self.mod_hash.clone(),
                    timeout: self.timeout.clone(),
                    mover_puzzle_hash: mover_ph.clone(),
                    waiter_puzzle_hash: waiter_ph.clone(),
                    amount: self.start.amount.clone(),
                    game_move: GameMoveDetails {
                        basic: GameMoveStateInfo {
                            move_made: move_to_check.to_vec(),
                            mover_share: self.mover_share.clone(),
                            max_move_size: 0, // unused in v1
                        },
                        validation_info_hash: ValidationInfo::new_state_update(
                            allocator,
                            validation_program.clone(),
                            self.state.p(),
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

    pub fn get_move_inputs(
        &mut self,
        allocator: &mut AllocEncoder,
        mover_share: Amount,
        slash: u8,
    ) -> Result<ExhaustiveMoveInputs, Error> {
        debug!("generating move inputs with count {}", self.move_count);
        let (redo, validation_program) = if self.validation_program_queue.is_empty() {
            (
                true,
                StateUpdateProgram::new(allocator, "dummy", Rc::new(Program::from_hex("80")?)),
            )
        } else {
            (false, self.validation_program_queue[0].clone())
        };

        let validation_info = ValidationInfo::new_state_update(
            allocator,
            validation_program.clone().into(),
            self.state.p(),
        );

        let emove = ExhaustiveMoveInputs {
            alice_puzzle_hash: self.alice_identity.puzzle_hash.clone(),
            bob_puzzle_hash: self.bob_identity.puzzle_hash.clone(),
            amount: self.start.amount.clone(),
            count: self.move_count,
            max_move_size: self.max_move_size,
            mod_hash: self.mod_hash.clone(),
            mover_share: self.mover_share.clone(),
            nonce: self.nonce,
            timeout: self.timeout.clone(),
            validation_program: validation_program,
            validation_info: validation_info,
            incoming_state_validation_info_hash: self
                .get_previous_validation_info_hash(allocator)
                .map(|v| v.hash().clone()),
            slash: slash,
            opponent_mover_share: mover_share.clone(),
            previous_validation_info: self.last_validation_data.clone(),
            entropy: self.rng[self.move_count].clone(),
        };

        self.prime_my_turn(allocator, &emove)?;

        if redo {
            self.get_move_inputs(allocator, mover_share, slash)
        } else {
            Ok(emove)
        }
    }

    pub fn state_update_for_own_move(
        &mut self,
        allocator: &mut AllocEncoder,
        move_to_check: &[u8],
        evidence: Evidence,
    ) -> Result<StateUpdateResult, Error> {
        let vprog = self.validation_program_queue[0].clone();
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
        allocator: &mut AllocEncoder,
        inputs: &ExhaustiveMoveInputs,
    ) -> Result<Option<Rc<Program>>, Error> {
        // Run validator for their turn.
        let vprog = self.validation_program_queue.pop_front().unwrap();
        let move_to_check = inputs.to_linear_move(allocator, true)?;
        let previous_validation_info_hash = inputs.previous_validation_info_hash(allocator)?;
        let evidence = Evidence::nil()?;
        debug!("my mover share {:?}", self.mover_share);
        debug!("validation program {:?}", vprog.to_program());
        let validator_response = self.generic_run_state_update(
            allocator,
            vprog.clone(),
            previous_validation_info_hash.clone(),
            &move_to_check,
            evidence,
        )?;

        let (state, tt_result) = match validator_response {
            StateUpdateResult::MoveOk(state, _, 512) => {
                let state_node = state.to_clvm(allocator).into_gen()?;
                (
                    state.clone(),
                    self.handler.call_their_turn_driver(
                        allocator,
                        &TheirTurnInputs {
                            amount: self.start.amount.clone(),
                            state: state_node,
                            last_move: &move_to_check,
                            last_mover_share: self.mover_share.clone(),
                            new_move: GameMoveDetails {
                                basic: GameMoveStateInfo {
                                    move_made: move_to_check.clone(),
                                    mover_share: inputs.opponent_mover_share.clone(),
                                    max_move_size: 0, // unused in v1
                                },
                                validation_info_hash: vprog.hash().clone(),
                            },
                        },
                    )?,
                )
            }
            StateUpdateResult::Slash(evidence) => {
                return Ok(Some(evidence));
            }
            _ => todo!(),
        };

        match tt_result {
            TheirTurnResult::MakeMove(new_handler, _message, tt_data) => {
                self.handler = new_handler.v1();
                for evidence in tt_data.slash_evidence.iter() {
                    let validator_response = self.generic_run_state_update(
                        allocator,
                        vprog.clone(),
                        previous_validation_info_hash.clone(),
                        &move_to_check,
                        evidence.clone(),
                    )?;
                    if let StateUpdateResult::Slash(evidence1) = validator_response {
                        debug!("SLASH DETECTED: EVIDENCE {evidence:?} {evidence1:?}");
                        self.slash_detected = Some(evidence.clone());
                        return Ok(Some(evidence.to_program()));
                    }
                }
                self.move_count += 1;
                self.handler = new_handler.v1();
                self.state = state.clone().into();
                self.next_mover_share = tt_data.mover_share.clone();
                self.mover_share = tt_data.mover_share.clone();
                self.last_validation_data = Some((vprog.clone(), state.into()));
                debug!("Accepted their turn");
            }
            _ => todo!(),
        }
        Ok(None)
    }

    /// Do a full 'my turn' and 'their turn' cycle for a single move.
    pub fn do_move(
        &mut self,
        allocator: &mut AllocEncoder,
        peer: &mut BareDebugGameDriver,
        mover_share: Amount,
        slash: u8,
    ) -> Result<DebugGameMoveInfo, Error> {
        assert!(self.i_am_alice == ((self.move_count & 1) == 0));
        let predicted_move = self
            .get_move_inputs(allocator, mover_share, slash)
            .expect("good");
        let move_data = predicted_move
            .to_linear_move(allocator, true)
            .expect("good");
        debug!("move_data {move_data:?}");
        let validation_result = self
            .state_update_for_own_move(allocator, &move_data, Evidence::nil().expect("good"))
            .expect("good");
        debug!("validation_result {validation_result:?}");
        assert!(matches!(
            validation_result,
            StateUpdateResult::MoveOk(_, _, 512)
        ));
        debug!("end my turn");
        self.end_my_turn(allocator, &predicted_move).expect("good");
        debug!("accept move");
        let move_success_0 = peer.accept_move(allocator, &predicted_move).expect("good");
        Ok(DebugGameMoveInfo {
            ui_move: predicted_move.get_ui_move(allocator)?,
            slash: move_success_0,
            move_data,
        })
    }
}

pub fn make_debug_games(
    allocator: &mut AllocEncoder,
    rng: &mut ChaCha8Rng,
    identities: &[ChiaIdentity],
) -> Result<[BareDebugGameDriver; 2], Error> {
    let rng_seq0: Vec<Hash> = (0..50).map(|_| rng.gen()).collect();
    let gid = GameID::default();
    let referee_coin = read_hex_puzzle(allocator, "clsp/referee/onchain/referee-v1.hex")?;
    let ref_coin_hash = referee_coin.sha256tree(allocator);
    BareDebugGameDriver::new(
        allocator,
        gid,
        0,
        identities,
        &ref_coin_hash,
        Timeout::new(10),
        &rng_seq0,
    )
}

#[test]
fn test_debug_game_factory() {
    let mut allocator = AllocEncoder::new();
    let rng_seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(rng_seed);
    let pk0: PrivateKey = rng.gen();
    let pk1: PrivateKey = rng.gen();
    let id0 = ChiaIdentity::new(&mut allocator, pk0).expect("ok");
    let id1 = ChiaIdentity::new(&mut allocator, pk1).expect("ok");
    let identities: [ChiaIdentity; 2] = [id0, id1];
    let debug_games = make_debug_games(&mut allocator, &mut rng, &identities).expect("good");
    assert_eq!(512, debug_games[0].game.starts[0].initial_max_move_size);
    assert_eq!(
        debug_games[0].game.starts[0].initial_max_move_size,
        debug_games[1].game.starts[0].initial_max_move_size
    );
}

pub struct ExhaustiveMoveInputs {
    alice_puzzle_hash: PuzzleHash,
    bob_puzzle_hash: PuzzleHash,
    mod_hash: PuzzleHash,
    validation_info: ValidationInfo,
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
    previous_validation_info: Option<(StateUpdateProgram, ProgramRef)>,
}

fn at_least_one_byte(allocator: &mut AllocEncoder, value: u64) -> Result<NodePtr, Error> {
    if value == 0 {
        allocator
            .encode_atom(clvm_traits::Atom::Borrowed(&[0]))
            .into_gen()
    } else {
        value.to_clvm(allocator).into_gen()
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
            .encode_atom(clvm_traits::Atom::Borrowed(
                &linear_move[0..(linear_move.len() - move_tail.len())],
            ))
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
        let amount_atom = at_least_one_byte(allocator, self.opponent_mover_share.to_u64())?;
        let slash_atom = self.slash_atom(allocator)?;
        let args = [Node(amount_atom), Node(slash_atom)]
            .to_clvm(allocator)
            .into_gen()?;
        let program_to_concat = Program::from_hex("ff0eff02ff0580")?;
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
        let alice_mover = (self.count % 2) == 0;
        let mover_ph_ref = if alice_mover {
            &self.alice_puzzle_hash
        } else {
            &self.bob_puzzle_hash
        };
        let waiter_ph_ref = if off_chain {
            None
        } else if alice_mover {
            Some(&self.bob_puzzle_hash)
        } else {
            Some(&self.alice_puzzle_hash)
        };
        let pv_hash = self.validation_program.sha256tree(allocator);
        let timeout_atom = at_least_one_byte(allocator, self.timeout.to_u64())?;
        assert_ne!(self.amount, Amount::default());
        let amount_atom = at_least_one_byte(allocator, self.amount.to_u64())?;
        let nonce_atom = at_least_one_byte(allocator, self.nonce as u64)?;
        let max_move_size_atom = at_least_one_byte(allocator, self.max_move_size as u64)?;
        let mover_share_atom = at_least_one_byte(allocator, self.mover_share.to_u64())?;
        let count_atom = at_least_one_byte(allocator, self.count as u64)?;
        let mut tail_bytes = self.move_tail(allocator)?;
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
                                    Node(timeout_atom),
                                    (
                                        Node(amount_atom),
                                        (
                                            Node(nonce_atom),
                                            (
                                                Node(max_move_size_atom),
                                                (Node(mover_share_atom), (Node(count_atom), ())),
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

        let program_to_concat = Program::from_hex(
            "ff0eff02ff05ff0bff17ff2fff5fff8200bfff82017fff8202ffff8205ffff820bffff8217ff80",
        )?;
        let pnode = program_to_concat.to_clvm(allocator).into_gen()?;
        let result_atom = run_program(allocator.allocator(), &chia_dialect(), pnode, args, 0)
            .into_gen()?
            .1;
        if let Some(mut result_move_data) = atom_from_clvm(allocator, result_atom) {
            debug!(
                "generated move data {} {result_move_data:?}",
                result_move_data.len()
            );
            debug!("tail_bytes {tail_bytes:?}");
            result_move_data.append(&mut tail_bytes);
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
            let validation_info =
                ValidationInfo::new_state_update(allocator, vprog.clone(), vstate.p());
            Ok(Some(validation_info.hash().clone()))
        } else {
            Ok(None)
        }
    }
}

#[test]
fn test_debug_game_validation_move() {
    let mut allocator = AllocEncoder::new();
    let rng_seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(rng_seed);
    let pk0: PrivateKey = rng.gen();
    let pk1: PrivateKey = rng.gen();
    let id0 = ChiaIdentity::new(&mut allocator, pk0).expect("ok");
    let id1 = ChiaIdentity::new(&mut allocator, pk1).expect("ok");
    let identities: [ChiaIdentity; 2] = [id0, id1];
    let mut debug_games = make_debug_games(&mut allocator, &mut rng, &identities).expect("good");
    let debug_games = pair_of_array_mut(&mut debug_games);

    assert_eq!(
        debug_games.0.game.starts[0].initial_validation_program,
        debug_games.1.game.starts[0].initial_validation_program
    );

    debug!("do move 0 (alice)");
    let _move1 = debug_games
        .0
        .do_move(&mut allocator, debug_games.1, Amount::default(), 0)
        .expect("ok");

    debug!(
        "do move 1 (bob) at {} {}",
        debug_games.0.move_count, debug_games.1.move_count
    );
    let _move2 = debug_games
        .1
        .do_move(&mut allocator, debug_games.0, Amount::default(), 0)
        .expect("ok");
}
