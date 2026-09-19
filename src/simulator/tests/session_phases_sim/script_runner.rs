use super::harness::SimulationHarness;
use super::*;
use std::collections::BTreeMap;

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
        game_id: ScriptGameRef,
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

pub(in super::super) fn run_script(
    allocator: &mut AllocEncoder,
    rng: &mut ChaCha8Rng,
    identities: &[ChiaIdentity],
    package_key: &str,
    extras: &Program,
    moves_input: &[SimScriptAction],
    pred: GameRunEarlySuccessPredicate,
    neutral_identity: &ChiaIdentity,
    launcher_coin: &CoinString,
    mut harness: SimulationHarness,
) -> Result<(SimulationHarness, bool), Error> {
    let mut move_number = 0;
    let mut handshake_done = false;
    let mut ending = None;
    let mut assertion_scheduler = AssertionScheduler::default();
    let proposal_type =
        crate::session_phases::game_collection::game_type_for_package(allocator, package_key);
    let proposal_member_count = usize::from(package_key == "krunk") + 1;
    let krunk_type =
        crate::session_phases::game_collection::game_type_for_package(allocator, "krunk");

    let has_explicit_go_on_chain = moves_input
        .iter()
        .any(|action| action.schedule().expects_on_chain_transition);

    for action in moves_input
        .iter()
        .take_while(|action| matches!(action, SimScriptAction::NerfTransactions(_)))
    {
        let SimScriptAction::NerfTransactions(player) = action else {
            unreachable!();
        };
        harness.nerf_transactions(*player);
    }

    while !matches!(ending, Some(0)) {
        if let Some(action) = moves_input.get(move_number) {
            harness.establish_readiness_boundary(move_number, action.schedule().readiness);
        }
        harness.begin_step(move_number, moves_input.get(move_number));
        let (_progress, early_success) = harness.pump_block(
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
        } else if moves_input.get(move_number).is_some_and(|action| {
            harness.establish_readiness_boundary(move_number, action.schedule().readiness);
            harness.readiness_satisfied(move_number, action.schedule().readiness)
        }) {
            if move_number < moves_input.len() {
                let ga = &moves_input[move_number];
                let schedule = ga.schedule();
                let mut advance_script = true;

                match ga {
                    SimScriptAction::Move(who, gid, readable, _share) => {
                        harness.make_move(allocator, *who, gid, readable.clone(), rng.random())?;
                        ()
                    }
                    SimScriptAction::ProposeNewGame(who, _trigger)
                    | SimScriptAction::ProposeNewGameTheirTurn(who, _trigger)
                    | SimScriptAction::ProposeNewGameWithTimeout(who, _trigger, _)
                    | SimScriptAction::ProposeNewGameAs(who, _, _trigger) => {
                        let my_turn = matches!(
                            ga,
                            SimScriptAction::ProposeNewGame(_, _)
                                | SimScriptAction::ProposeNewGameWithTimeout(_, _, _)
                                | SimScriptAction::ProposeNewGameAs(_, _, _)
                        );
                        let timeout = match ga {
                            SimScriptAction::ProposeNewGameWithTimeout(_, _, timeout) => *timeout,
                            _ => 15,
                        };
                        let reference = match ga {
                            SimScriptAction::ProposeNewGameAs(_, reference, _) => Some(*reference),
                            _ => None,
                        };
                        let parameters = if package_key == "calpoker" || package_key == "krunk" {
                            let stake = 100u64.to_clvm(allocator).into_gen()?;
                            Program::from_nodeptr(allocator, stake)?
                        } else if package_key == "spacepoker" {
                            extras.clone()
                        } else if package_key == "debug" {
                            extras.clone()
                        } else {
                            extras.clone()
                        };
                        let parameters =
                            ProposalParameters::from_program_for_testing(allocator, &parameters)?;
                        let parameters = if package_key == "spacepoker" {
                            ProposalParameters::List(vec![
                                ProposalParameters::Integer(10),
                                parameters,
                            ])
                        } else {
                            parameters
                        };
                        harness.propose(
                            allocator,
                            *who,
                            reference,
                            &[GameProposal {
                                sender_is_player_a: my_turn,
                                game_type: proposal_type.clone(),
                                timeout: Timeout::new(timeout),
                                parameters,
                            }],
                            proposal_member_count,
                        )?;
                        ()
                    }
                    SimScriptAction::ProposeKrunkGroup(who, _trigger) => {
                        harness.propose(
                            allocator,
                            *who,
                            None,
                            &[GameProposal {
                                sender_is_player_a: true,
                                game_type: krunk_type.clone(),
                                timeout: Timeout::new(15),
                                parameters: ProposalParameters::Integer(100),
                            }],
                            2,
                        )?;
                        ()
                    }
                    SimScriptAction::AcceptProposal(who, gid) => {
                        if harness.accept_proposal(allocator, *who, gid)? {
                            advance_script = false;
                        }
                        ()
                    }
                    SimScriptAction::AcceptProposalPair(who, first, second) => {
                        if harness.accept_proposal_pair(allocator, *who, first, second)? {
                            advance_script = false;
                        }
                        ()
                    }
                    SimScriptAction::MalformedAcceptProposal(who, local, wire) => {
                        if !harness.malformed_accept_proposal(allocator, *who, local, wire)? {
                            advance_script = false;
                        }
                        ()
                    }
                    SimScriptAction::MalformedSecondAcceptInPair(
                        who,
                        first,
                        second,
                        replacement_wire_id,
                    ) => {
                        if !harness.malformed_second_accept_in_pair(
                            allocator,
                            *who,
                            first,
                            second,
                            replacement_wire_id,
                        )? {
                            advance_script = false;
                        }
                        ()
                    }
                    SimScriptAction::CancelProposal(who, gid) => {
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
                        harness.tamper_next_batch_signature(*who);
                        let entropy = rng.random();
                        harness.make_move(allocator, *who, gid, readable.clone(), entropy)?;
                        ()
                    }
                    SimScriptAction::Cheat(who, gid, cheat_share) => {
                        harness.cheat(allocator, *who, gid, cheat_share.clone())?;
                        ()
                    }
                    SimScriptAction::ForceDestroyCoin(who, gid) => {
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
                    SimScriptAction::MutateNerfedShutdownSolution => {
                        harness.mutate_nerfed_shutdown_solution(allocator)?;
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
                    SimScriptAction::WaitForChannel(_) => {}
                    SimScriptAction::WaitForProposal(_, _) => {}
                    SimScriptAction::WaitForMoveApplied(_, _) => {}
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
                        let parameters = if package_key == "calpoker" {
                            Program::nil()
                        } else if package_key == "spacepoker" {
                            extras.clone()
                        } else {
                            extras.clone()
                        };
                        let parameters =
                            ProposalParameters::from_program_for_testing(allocator, &parameters)?;
                        harness.propose(
                            allocator,
                            *who,
                            None,
                            &[GameProposal {
                                sender_is_player_a: true,
                                game_type: proposal_type.clone(),
                                timeout: Timeout::new(15),
                                parameters,
                            }],
                            proposal_member_count,
                        )?;
                        harness.mutate_last_proposal(*who, |wire| {
                            wire.origin_wire_id = WireProposalId(wire.origin_wire_id.0 ^ 1);
                            Ok(())
                        })?;
                        ()
                    }
                    SimScriptAction::InvalidProposalParameters(who) => {
                        let parameters = if package_key == "calpoker" {
                            Program::nil()
                        } else if package_key == "spacepoker" {
                            extras.clone()
                        } else {
                            extras.clone()
                        };
                        let parameters =
                            ProposalParameters::from_program_for_testing(allocator, &parameters)?;
                        harness.propose(
                            allocator,
                            *who,
                            None,
                            &[GameProposal {
                                sender_is_player_a: true,
                                game_type: proposal_type.clone(),
                                timeout: Timeout::new(15),
                                parameters,
                            }],
                            proposal_member_count,
                        )?;
                        let invalid_parameters = if package_key == "calpoker" {
                            ProposalParameters::Integer(1)
                        } else {
                            ProposalParameters::Null
                        };
                        harness.mutate_last_proposal(*who, move |wire| {
                            wire.start.parameters = invalid_parameters;
                            Ok(())
                        })?;
                        ()
                    }
                    SimScriptAction::SkippedProposalWireId(who) => {
                        let parameters = if package_key == "calpoker" {
                            ProposalParameters::Null
                        } else if package_key == "spacepoker" {
                            ProposalParameters::from_program_for_testing(allocator, extras)?
                        } else {
                            ProposalParameters::from_program_for_testing(allocator, extras)?
                        };
                        harness.propose(
                            allocator,
                            *who,
                            None,
                            &[GameProposal {
                                sender_is_player_a: true,
                                game_type: proposal_type.clone(),
                                timeout: Timeout::new(15),
                                parameters,
                            }],
                            proposal_member_count,
                        )?;
                        harness.mutate_last_proposal(*who, |wire| {
                            wire.origin_wire_id = WireProposalId(wire.origin_wire_id.0 + 2);
                            Ok(())
                        })?;
                        ()
                    }
                    SimScriptAction::ReusedProposalWireId(who) => {
                        let parameters = if package_key == "calpoker" {
                            ProposalParameters::Integer(1)
                        } else {
                            ProposalParameters::from_program_for_testing(allocator, extras)?
                        };
                        harness.propose(
                            allocator,
                            *who,
                            None,
                            &[GameProposal {
                                sender_is_player_a: true,
                                game_type: proposal_type.clone(),
                                timeout: Timeout::new(15),
                                parameters,
                            }],
                            proposal_member_count,
                        )?;
                        harness.mutate_last_proposal(*who, |wire| {
                            wire.origin_wire_id =
                                WireProposalId(wire.origin_wire_id.0.saturating_sub(2));
                            Ok(())
                        })?;
                        ()
                    }
                    SimScriptAction::UnknownProposalGameType(who) => {
                        let parameters = if package_key == "calpoker" {
                            Program::nil()
                        } else {
                            extras.clone()
                        };
                        let parameters =
                            ProposalParameters::from_program_for_testing(allocator, &parameters)?;
                        harness.propose(
                            allocator,
                            *who,
                            None,
                            &[GameProposal {
                                sender_is_player_a: true,
                                game_type: proposal_type.clone(),
                                timeout: Timeout::new(15),
                                parameters,
                            }],
                            proposal_member_count,
                        )?;
                        harness.mutate_last_proposal(*who, |wire| {
                            wire.start.game_type =
                                GameType::from_hash(Hash::from_bytes([0x5a; 32]));
                            Ok(())
                        })?;
                        ()
                    }
                    SimScriptAction::InvalidProposalTimeout(who) => {
                        let parameters = if package_key == "calpoker" {
                            Program::nil()
                        } else if package_key == "spacepoker" {
                            extras.clone()
                        } else {
                            extras.clone()
                        };
                        let parameters =
                            ProposalParameters::from_program_for_testing(allocator, &parameters)?;
                        harness.propose(
                            allocator,
                            *who,
                            None,
                            &[GameProposal {
                                sender_is_player_a: true,
                                game_type: proposal_type.clone(),
                                timeout: Timeout::new(15),
                                parameters,
                            }],
                            proposal_member_count,
                        )?;
                        harness.mutate_last_proposal(*who, |wire| {
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
                    if let Some(action) = moves_input.get(move_number) {
                        harness
                            .establish_readiness_boundary(move_number, action.schedule().readiness);
                    }
                }
                if schedule.post_action_drain == PostActionDrain::OnChain && harness.any_on_chain()
                {
                    harness.drain_to_quiescence(allocator, identities, launcher_coin)?;
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

    #[test]
    fn deferred_assertion_resumes_the_whole_contiguous_block_at_one_tip() {
        let assertion = || {
            SimScriptAction::Assert(SimAssertion::GameCoinTimeoutRegistered(
                0,
                ScriptGameRef::accepted(1, 0),
            ))
        };
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
}
