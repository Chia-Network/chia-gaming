use super::harness::{ResyncEvent, SimulationHarness};
use super::*;
use crate::common::types::Hash;
use std::collections::{BTreeMap, VecDeque};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum AssertionReadiness {
    Passed,
    AwaitNextBlock,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StepOutcome {
    Ready,
    AwaitNextBlock,
}

#[derive(Clone, Debug)]
enum DeferredAssertion {
    GameCoinPublished {
        player: usize,
        game_id: GameID,
        parent: CoinString,
        submitted_height: usize,
    },
}

#[derive(Default)]
struct AssertionScheduler {
    deferred_by_action_index: BTreeMap<usize, DeferredAssertion>,
}

impl AssertionScheduler {
    fn evaluate(
        &mut self,
        harness: &SimulationHarness,
        action_index: usize,
        assertion: &SimAssertion,
    ) -> AssertionReadiness {
        match assertion {
            SimAssertion::GameCoinPublished(player, game_id) => {
                if let Some(deferred) = self.deferred_by_action_index.remove(&action_index) {
                    let DeferredAssertion::GameCoinPublished {
                        player: checkpoint_player,
                        game_id: checkpoint_game_id,
                        parent,
                        submitted_height,
                    } = deferred;
                    assert_eq!(
                        (checkpoint_player, checkpoint_game_id),
                        (*player, *game_id),
                        "action {action_index} resumed a different game-coin publication assertion"
                    );
                    harness.assert_game_coin_child_published(
                        *player,
                        *game_id,
                        &parent,
                        submitted_height,
                    );
                    AssertionReadiness::Passed
                } else {
                    let (parent, submitted_height) =
                        harness.assert_game_coin_submitted(*player, *game_id);
                    self.deferred_by_action_index.insert(
                        action_index,
                        DeferredAssertion::GameCoinPublished {
                            player: *player,
                            game_id: *game_id,
                            parent,
                            submitted_height,
                        },
                    );
                    AssertionReadiness::AwaitNextBlock
                }
            }
            SimAssertion::GameCoinTimeoutRegistered(player, game_id) => {
                harness.assert_game_coin_timeout_registered(*player, *game_id);
                AssertionReadiness::Passed
            }
        }
    }
}

fn gid_diag_enabled() -> bool {
    std::env::var("SIM_GID_DIAG").is_ok()
}

fn gid_diag(test_name: &str, action_idx: usize, label: &str, requested: &GameID, runtime: &GameID) {
    eprintln!(
        "GID-DIAG test={test_name} action={action_idx} op={label} requested={:?} runtime={:?}",
        requested, runtime
    );
}

fn process_assertions(
    harness: &SimulationHarness,
    actions: &[SimScriptAction],
    cursor: &mut usize,
    scheduler: &mut AssertionScheduler,
) -> StepOutcome {
    process_assertion_block(actions, cursor, |action_index, assertion| {
        scheduler.evaluate(harness, action_index, assertion)
    })
}

fn process_assertion_block(
    actions: &[SimScriptAction],
    cursor: &mut usize,
    mut evaluate: impl FnMut(usize, &SimAssertion) -> AssertionReadiness,
) -> StepOutcome {
    while let Some(SimScriptAction::Assert(assertion)) = actions.get(*cursor) {
        match evaluate(*cursor, assertion) {
            AssertionReadiness::Passed => *cursor += 1,
            AssertionReadiness::AwaitNextBlock => return StepOutcome::AwaitNextBlock,
        }
    }
    StepOutcome::Ready
}

#[derive(Clone, Debug)]
struct ExecutedMove {
    player: usize,
    game_id: GameID,
    state_number: usize,
    action_index: usize,
    readable: ReadableMove,
    entropy: Hash,
}

fn enqueue_resync_replays(
    events: &[ResyncEvent],
    history: &[ExecutedMove],
    replay_queue: &mut VecDeque<ExecutedMove>,
) -> Result<(), Error> {
    for event in events {
        if !event.is_my_turn {
            continue;
        }
        let matches: Vec<_> = history
            .iter()
            .filter(|executed| {
                executed.player == event.player
                    && executed.game_id == event.game_id
                    && executed.state_number == event.state_number
            })
            .collect();
        if matches.len() != 1 {
            return Err(Error::StrErr(format!(
                "resync requires exactly one executed move: player={} game_id={:?} state_number={} is_my_turn=true matches={} history={history:?}",
                event.player,
                event.game_id,
                event.state_number,
                matches.len(),
            )));
        }
        replay_queue.push_back(matches[0].clone());
    }
    Ok(())
}

pub(in super::super) fn run_script(
    allocator: &mut AllocEncoder,
    rng: &mut ChaCha8Rng,
    identities: &[ChiaIdentity],
    game_type: &[u8],
    extras: &Program,
    moves_input: &[SimScriptAction],
    pred: GameRunEarlySuccessPredicate,
    neutral_identity: &ChiaIdentity,
    launcher_coin: &CoinString,
    mut harness: SimulationHarness,
) -> Result<(SimulationHarness, bool), Error> {
    let mut move_number = 0;
    let mut handshake_done = false;
    let gid_diag_on = gid_diag_enabled();
    let test_name = crate::simulator::current_test_name().unwrap_or_else(|| "unknown".to_string());
    let mut ending = None;
    let mut executed_moves = Vec::new();
    let mut replay_queue = VecDeque::new();
    let mut assertion_scheduler = AssertionScheduler::default();

    let has_explicit_go_on_chain = moves_input
        .iter()
        .any(|action| action.schedule().expects_on_chain_transition);

    while !matches!(ending, Some(0)) {
        harness.begin_step(move_number, moves_input.get(move_number));
        let (progress, early_success) = harness.pump_block(
            allocator,
            identities,
            launcher_coin,
            neutral_identity,
            has_explicit_go_on_chain,
            move_number,
            moves_input.get(move_number),
            &pred,
        )?;
        if early_success {
            return Ok((harness, true));
        }
        enqueue_resync_replays(progress.resync_events(), &executed_moves, &mut replay_queue)?;
        harness.finish_step_timing(move_number);

        if process_assertions(
            &harness,
            moves_input,
            &mut move_number,
            &mut assertion_scheduler,
        ) == StepOutcome::AwaitNextBlock
        {
            continue;
        }

        if let Some(replay) = replay_queue.pop_front() {
            harness.make_move(
                allocator,
                replay.player,
                &replay.game_id,
                replay.readable,
                replay.entropy,
            )?;
            continue;
        }

        if harness.fully_resolved() && ending.is_none() {
            ending = Some(10);
        }
        if let Some(ending) = &mut ending {
            *ending -= 1;
        }
        if harness.handshake_checkpoint(&mut handshake_done) {
            continue;
        }
        if process_assertions(
            &harness,
            moves_input,
            &mut move_number,
            &mut assertion_scheduler,
        ) == StepOutcome::AwaitNextBlock
        {
            continue;
        }
        if harness.wait_active() {
            harness.advance_wait(allocator)?;
        } else if moves_input
            .get(move_number)
            .is_some_and(|action| harness.readiness_satisfied(action.schedule().readiness))
        {
            if move_number < moves_input.len() {
                let ga = &moves_input[move_number];
                let schedule = ga.schedule();
                let action_idx = move_number;
                let mut advance_script = true;

                match ga {
                    SimScriptAction::Move(who, gid, readable, _share) => {
                        if gid_diag_on {
                            gid_diag(&test_name, action_idx, "Move", gid, gid);
                        }
                        let state_number = harness.move_state_number(*who, gid)?;
                        let entropy: Hash = rng.random();
                        harness.make_move(
                            allocator,
                            *who,
                            gid,
                            readable.clone(),
                            entropy.clone(),
                        )?;
                        executed_moves.push(ExecutedMove {
                            player: *who,
                            game_id: *gid,
                            state_number,
                            action_index: action_idx,
                            readable: readable.clone(),
                            entropy,
                        });
                        ()
                    }
                    SimScriptAction::ProposeNewGame(who, _trigger)
                    | SimScriptAction::ProposeNewGameTheirTurn(who, _trigger)
                    | SimScriptAction::ProposeNewGameWithTimeout(who, _trigger, _) => {
                        let my_turn = matches!(
                            ga,
                            SimScriptAction::ProposeNewGame(_, _)
                                | SimScriptAction::ProposeNewGameWithTimeout(_, _, _)
                        );
                        let timeout = match ga {
                            SimScriptAction::ProposeNewGameWithTimeout(_, _, timeout) => *timeout,
                            _ => 15,
                        };
                        let parameters = if game_type == b"calpoker" {
                            let node = (Amount::new(100), (my_turn, ()))
                                .to_clvm(allocator)
                                .into_gen()?;
                            Program::from_nodeptr(allocator, node)?
                        } else if game_type == b"spacepoker" {
                            let node = (Amount::new(100), (extras.clone(), (my_turn, ())))
                                .to_clvm(allocator)
                                .into_gen()?;
                            Program::from_nodeptr(allocator, node)?
                        } else if game_type == b"debug" {
                            let node = (
                                Amount::new(100),
                                (Amount::new(100), (my_turn, (extras.clone(), ()))),
                            )
                                .to_clvm(allocator)
                                .into_gen()?;
                            Program::from_nodeptr(allocator, node)?
                        } else {
                            extras.clone()
                        };
                        harness.propose_games(
                            allocator,
                            *who,
                            &[GameProposal {
                                game_type: GameType(game_type.to_vec()),
                                timeout: Timeout::new(timeout),
                                parameters,
                            }],
                        )?;
                        ()
                    }
                    SimScriptAction::ProposeKrunkGroup(who, _trigger) => {
                        harness.propose_games(
                            allocator,
                            *who,
                            &[GameProposal {
                                game_type: GameType(b"krunk".to_vec()),
                                timeout: Timeout::new(15),
                                parameters: Program::from_hex("64")?,
                            }],
                        )?;
                        ()
                    }
                    SimScriptAction::AcceptProposal(who, gid) => {
                        if gid_diag_on {
                            gid_diag(&test_name, action_idx, "AcceptProposal", gid, gid);
                        }
                        if harness.accept_proposal(allocator, *who, gid)? {
                            advance_script = false;
                        }
                        ()
                    }
                    SimScriptAction::CancelProposal(who, gid) => {
                        if gid_diag_on {
                            gid_diag(&test_name, action_idx, "CancelProposal", gid, gid);
                        }
                        harness.cancel_proposal(allocator, *who, gid)?;
                        ()
                    }
                    SimScriptAction::GoOnChain(who) => {
                        if !harness.go_on_chain(allocator, *who, move_number + 1)? {
                            continue;
                        }
                        ()
                    }
                    SimScriptAction::FakeMove(who, gid, readable, move_data) => {
                        if gid_diag_on {
                            gid_diag(&test_name, action_idx, "FakeMove", gid, gid);
                        }
                        let entropy = rng.random();
                        harness.sabotage_move(
                            allocator,
                            *who,
                            gid,
                            readable.clone(),
                            entropy,
                            move_data,
                        )?;
                        ()
                    }
                    SimScriptAction::BadSignatureMove(who, gid, readable) => {
                        if gid_diag_on {
                            gid_diag(&test_name, action_idx, "BadSignatureMove", gid, gid);
                        }
                        harness.tamper_next_batch_signature(*who);
                        let entropy = rng.random();
                        harness.make_move(allocator, *who, gid, readable.clone(), entropy)?;
                        ()
                    }
                    SimScriptAction::Cheat(who, gid, cheat_share) => {
                        if gid_diag_on {
                            gid_diag(&test_name, action_idx, "Cheat", gid, gid);
                        }
                        harness.cheat(allocator, *who, gid, cheat_share.clone())?;
                        ()
                    }
                    SimScriptAction::ForceDestroyCoin(who, gid) => {
                        if gid_diag_on {
                            gid_diag(&test_name, action_idx, "ForceDestroyCoin", gid, gid);
                        }
                        if !harness.force_destroy_coin(*who, gid) {
                            continue;
                        }
                        ()
                    }
                    SimScriptAction::NerfTransactions(who) => {
                        harness.nerf_transactions(*who);
                        ()
                    }
                    SimScriptAction::UnNerfTransactionsFor(who) => {
                        harness.unnerf_transactions_for(*who);
                        ()
                    }
                    SimScriptAction::UnNerfTransactions(replay) => {
                        harness.unnerf_transactions(allocator, *replay)?;
                        ()
                    }
                    SimScriptAction::BlockCoinReports(who) => {
                        harness.block_coin_reports(*who);
                        ()
                    }
                    SimScriptAction::UnblockCoinReports(replay) => {
                        harness.unblock_coin_reports(allocator, *replay)?;
                        ()
                    }
                    SimScriptAction::NerfMessages(who) => {
                        harness.nerf_messages(*who);
                        ()
                    }
                    SimScriptAction::UnNerfMessages => {
                        harness.unnerf_messages();
                        ()
                    }
                    SimScriptAction::WaitBlocks(n, players) => {
                        harness.wait_blocks(*n, *players);
                        ()
                    }
                    SimScriptAction::AcceptSettlement(who, gid) => {
                        if gid_diag_on {
                            gid_diag(&test_name, action_idx, "AcceptSettlement", gid, gid);
                        }
                        harness.accept_settlement(allocator, *who, gid)?;
                        ()
                    }
                    SimScriptAction::Timeout(_who) => {
                        panic!("Timeout action is not supported in sim tests; use AcceptSettlement(player, game_id)");
                    }
                    SimScriptAction::CleanShutdown(who) => {
                        if !harness.clean_shutdown(allocator, *who)? {
                            continue;
                        }
                        ()
                    }
                    SimScriptAction::CorruptStateNumber(who, new_sn) => {
                        harness.corrupt_state_number(*who, *new_sn)?;
                        ()
                    }
                    SimScriptAction::ForceUnroll(who) => {
                        harness.force_unroll(allocator, *who)?;
                        ()
                    }
                    SimScriptAction::SaveUnrollSnapshot(who) => {
                        harness.save_unroll_snapshot(*who);
                        ()
                    }
                    SimScriptAction::ForceStaleUnroll(who) => {
                        harness.force_stale_unroll(allocator, *who)?;
                        ()
                    }
                    SimScriptAction::InjectRawMessage(who, data) => {
                        harness.inject_raw_message(*who, data)?;
                        ()
                    }
                    SimScriptAction::SelfAcceptProposal(who, gid) => {
                        harness.self_accept_proposal(allocator, *who, gid)?;
                        ()
                    }
                    SimScriptAction::WrongParityProposal(who) => {
                        let parameters = if game_type == b"calpoker" {
                            let node = (Amount::new(100), (true, ()))
                                .to_clvm(allocator)
                                .into_gen()?;
                            Program::from_nodeptr(allocator, node)?
                        } else if game_type == b"spacepoker" {
                            let node = (Amount::new(100), (extras.clone(), (true, ())))
                                .to_clvm(allocator)
                                .into_gen()?;
                            Program::from_nodeptr(allocator, node)?
                        } else {
                            extras.clone()
                        };
                        harness.propose_games(
                            allocator,
                            *who,
                            &[GameProposal {
                                game_type: GameType(game_type.to_vec()),
                                timeout: Timeout::new(15),
                                parameters,
                            }],
                        )?;
                        harness.mutate_last_proposal(allocator, *who, |wire| {
                            wire.members[0].game_id = GameID(wire.members[0].game_id.0 ^ 1);
                            Ok(())
                        })?;
                        ()
                    }
                    SimScriptAction::InvalidProposalParameters(who) => {
                        let parameters = if game_type == b"calpoker" {
                            let node = (Amount::new(100), (true, ()))
                                .to_clvm(allocator)
                                .into_gen()?;
                            Program::from_nodeptr(allocator, node)?
                        } else if game_type == b"spacepoker" {
                            let node = (Amount::new(100), (extras.clone(), (true, ())))
                                .to_clvm(allocator)
                                .into_gen()?;
                            Program::from_nodeptr(allocator, node)?
                        } else {
                            extras.clone()
                        };
                        harness.propose_games(
                            allocator,
                            *who,
                            &[GameProposal {
                                game_type: GameType(game_type.to_vec()),
                                timeout: Timeout::new(15),
                                parameters,
                            }],
                        )?;
                        harness.mutate_last_proposal(allocator, *who, |wire| {
                            wire.start.parameters = Program::from_hex("80")?;
                            Ok(())
                        })?;
                        ()
                    }
                    SimScriptAction::InvalidProposalTimeout(who) => {
                        let parameters = if game_type == b"calpoker" {
                            let node = (Amount::new(100), (true, ()))
                                .to_clvm(allocator)
                                .into_gen()?;
                            Program::from_nodeptr(allocator, node)?
                        } else if game_type == b"spacepoker" {
                            let node = (Amount::new(100), (extras.clone(), (true, ())))
                                .to_clvm(allocator)
                                .into_gen()?;
                            Program::from_nodeptr(allocator, node)?
                        } else {
                            extras.clone()
                        };
                        harness.propose_games(
                            allocator,
                            *who,
                            &[GameProposal {
                                game_type: GameType(game_type.to_vec()),
                                timeout: Timeout::new(15),
                                parameters,
                            }],
                        )?;
                        harness.mutate_last_proposal(allocator, *who, |wire| {
                            wire.start.timeout = Timeout::new(0);
                            Ok(())
                        })?;
                        ()
                    }
                    SimScriptAction::Assert(_) => {
                        unreachable!("assertions are consumed by the scheduler")
                    }
                }

                if advance_script {
                    move_number += 1;
                }
                if schedule.post_action_drain == PostActionDrain::OnChain && harness.any_on_chain()
                {
                    let progress =
                        harness.drain_to_quiescence(allocator, identities, launcher_coin)?;
                    enqueue_resync_replays(
                        progress.resync_events(),
                        &executed_moves,
                        &mut replay_queue,
                    )?;
                }
                if process_assertions(
                    &harness,
                    moves_input,
                    &mut move_number,
                    &mut assertion_scheduler,
                ) == StepOutcome::AwaitNextBlock
                {
                    continue;
                }
            }
        }
    }

    Ok((harness, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn executed_move(
        player: usize,
        game_id: GameID,
        state_number: usize,
        action_index: usize,
    ) -> ExecutedMove {
        ExecutedMove {
            player,
            game_id,
            state_number,
            action_index,
            readable: ReadableMove::from_program(Rc::new(Program::from_hex("80").expect("nil"))),
            entropy: Hash::from_bytes([action_index as u8; 32]),
        }
    }

    #[test]
    fn resync_enqueues_exact_fifo_replays_without_coalescing() {
        let history = [
            executed_move(1, GameID(3), 17, 4),
            executed_move(1, GameID(3), 19, 8),
            executed_move(1, GameID(5), 20, 9),
        ];
        let events = [
            ResyncEvent {
                player: 1,
                game_id: GameID(3),
                state_number: 19,
                is_my_turn: true,
            },
            ResyncEvent {
                player: 1,
                game_id: GameID(3),
                state_number: 19,
                is_my_turn: true,
            },
            ResyncEvent {
                player: 1,
                game_id: GameID(5),
                state_number: 20,
                is_my_turn: true,
            },
        ];
        let mut queue = VecDeque::new();

        enqueue_resync_replays(&events, &history, &mut queue).expect("exact matches");

        let action_indexes: Vec<_> = queue.iter().map(|replay| replay.action_index).collect();
        assert_eq!(action_indexes, vec![8, 8, 9]);
    }

    #[test]
    fn non_my_turn_resync_is_observed_without_replay() {
        let mut queue = VecDeque::new();
        enqueue_resync_replays(
            &[
                ResyncEvent {
                    player: 0,
                    game_id: GameID(1),
                    state_number: 4,
                    is_my_turn: false,
                },
                ResyncEvent {
                    player: 1,
                    game_id: GameID(5),
                    state_number: 23,
                    is_my_turn: false,
                },
            ],
            &[],
            &mut queue,
        )
        .expect("opponent owns the next action");
        assert!(queue.is_empty());
    }

    #[test]
    fn my_turn_resync_without_exact_state_history_fails_fast() {
        let history = [executed_move(1, GameID(5), 22, 7)];
        let mut queue = VecDeque::new();
        let error = enqueue_resync_replays(
            &[ResyncEvent {
                player: 1,
                game_id: GameID(5),
                state_number: 23,
                is_my_turn: true,
            }],
            &history,
            &mut queue,
        )
        .expect_err("state number mismatch must not use heuristic history");

        assert!(
            format!("{error:?}")
                .contains("player=1 game_id=GameID(5) state_number=23 is_my_turn=true matches=0"),
            "unexpected diagnostic: {error:?}"
        );
        assert!(queue.is_empty());
    }

    #[test]
    fn deferred_assertion_resumes_the_whole_contiguous_block_at_one_tip() {
        let assertion =
            || SimScriptAction::Assert(SimAssertion::GameCoinTimeoutRegistered(0, GameID(1)));
        let actions = [assertion(), assertion(), assertion()];
        let mut cursor = 0;

        assert_eq!(
            process_assertion_block(&actions, &mut cursor, |_, _| {
                AssertionReadiness::AwaitNextBlock
            }),
            StepOutcome::AwaitNextBlock
        );
        assert_eq!(cursor, 0);

        let mut evaluations = 0;
        assert_eq!(
            process_assertion_block(&actions, &mut cursor, |_, _| {
                evaluations += 1;
                AssertionReadiness::Passed
            }),
            StepOutcome::Ready
        );
        assert_eq!(evaluations, 3);
        assert_eq!(cursor, actions.len());
    }

    #[test]
    fn exact_replay_queue_does_not_detach_deferred_assertion() {
        let assertion_index = 12;
        let mut scheduler = AssertionScheduler::default();
        scheduler.deferred_by_action_index.insert(
            assertion_index,
            DeferredAssertion::GameCoinPublished {
                player: 1,
                game_id: GameID(3),
                parent: CoinString::from_parts(
                    &CoinID::new(Hash::from_bytes([1; 32])),
                    &PuzzleHash::from_bytes([2; 32]),
                    &Amount::new(100),
                ),
                submitted_height: 40,
            },
        );
        let mut replay_queue = VecDeque::from([executed_move(1, GameID(3), 9, 7)]);

        assert_eq!(replay_queue.pop_front().unwrap().action_index, 7);
        assert!(scheduler
            .deferred_by_action_index
            .contains_key(&assertion_index));
        assert!(!scheduler.deferred_by_action_index.contains_key(&7));
    }
}
