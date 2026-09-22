use super::*;

fn settled_debug_outcome(
    allocator: &mut AllocEncoder,
    rng: &mut ChaCha8Rng,
) -> (GameRunOutcome, Rc<Program>, usize) {
    let moves = [DebugGameTestMove::new(100, 0)];
    let DebugGameSimSetup {
        private_keys,
        identities,
        mut game_actions,
        args_program,
    } = setup_debug_test(allocator, rng, &moves).expect("setup");
    game_actions.push(SimScriptAction::AcceptSettlement(
        1,
        ScriptGameRef::accepted(1, 0),
    ));
    game_actions.push(SimScriptAction::WaitBlocks(5, 0));

    let outcome = run_game_container_with_action_list_with_success_predicate(
        allocator,
        rng,
        private_keys,
        &identities,
        "debug",
        &args_program,
        &game_actions,
        Some(&|_, cradles| {
            cradles.iter().all(|session| {
                session
                    .allocated_balances_for_testing()
                    .is_ok_and(|balances| balances == (Amount::default(), Amount::default()))
            }) && cradles
                .iter()
                .any(|session| session.has_potato_for_testing())
        }),
        None,
    )
    .expect("settle initial game");

    let holder = if outcome.cradles[0].has_potato_for_testing() {
        0
    } else {
        1
    };
    assert!(
        outcome.cradles[holder].has_potato_for_testing(),
        "one settled session must hold the potato"
    );
    (outcome, args_program, holder)
}

fn debug_proposal(allocator: &mut AllocEncoder, args_program: &Program) -> GameProposal {
    GameProposal {
        sender_is_player_a: true,
        game_type: crate::session_phases::game_collection::game_type_for_package(
            allocator, "debug",
        ),
        timeout: Timeout::new(15),
        parameters: ProposalParameters::from_program_for_testing(allocator, args_program)
            .expect("debug proposal parameters"),
    }
}

fn test_failing_action_is_removed_in_place() {
    let mut allocator = AllocEncoder::new();
    let mut rng = ChaCha8Rng::from_seed([41; 32]);
    let (mut outcome, args_program, holder) = settled_debug_outcome(&mut allocator, &mut rng);

    let first_proposal = debug_proposal(&mut allocator, &args_program);
    outcome.cradles[holder]
        .propose(&mut allocator, &first_proposal)
        .expect("queue first valid proposal");
    outcome.cradles[holder]
        .queue_game_action_for_testing(GameAction::AcceptSettlement(GameID(999)))
        .expect("queue attributable failure");
    let later_proposal = debug_proposal(&mut allocator, &args_program);
    outcome.cradles[holder]
        .propose(&mut allocator, &later_proposal)
        .expect("queue later valid proposal");

    let failed = outcome.cradles[holder]
        .flush_and_collect(&mut allocator)
        .expect("collect action failure");
    assert!(!failed
        .events
        .iter()
        .any(|event| matches!(event, GameSessionEvent::OutboundMessage(_))));
    assert!(failed.events.iter().any(|event| matches!(
        event,
        GameSessionEvent::Notification(GameNotification::ActionFailed {
            id: Some(GameID(999)),
            action: Some(FailedGameAction::AcceptSettlement),
            ..
        })
    )));

    let retry = outcome.cradles[holder]
        .flush_and_collect(&mut allocator)
        .expect("retry surviving actions");
    let retry_message = retry
        .events
        .iter()
        .find_map(|event| match event {
            GameSessionEvent::OutboundMessage(bytes) => Some(bytes),
            _ => None,
        })
        .expect("retry batch");
    let retry_batch =
        crate::session_phases::peer_wire::decode_peer_message(retry_message).expect("decode");
    assert!(matches!(
        retry_batch,
        PeerMessage::Batch { ref actions, .. }
            if actions.len() == 2
                && actions.iter().all(|action| matches!(action, BatchAction::Propose(_)))
    ));
}

fn test_finalization_failure_preserves_full_queue() {
    let mut allocator = AllocEncoder::new();
    let mut rng = ChaCha8Rng::from_seed([42; 32]);
    let (mut outcome, args_program, holder) = settled_debug_outcome(&mut allocator, &mut rng);

    let proposal = debug_proposal(&mut allocator, &args_program);
    let proposal_id = outcome.cradles[holder]
        .propose(&mut allocator, &proposal)
        .expect("queue proposal");
    outcome.cradles[holder]
        .queue_game_action_for_testing(GameAction::QueuedCancelProposal(proposal_id))
        .expect("queue cancellation with staged notification");
    outcome.cradles[holder]
        .fail_next_cached_unroll_update_for_testing()
        .expect("inject finalization failure");

    let failed = outcome.cradles[holder]
        .flush_and_collect(&mut allocator)
        .expect("collect finalization failure");
    assert!(failed.events.iter().any(|event| matches!(
        event,
        GameSessionEvent::Notification(GameNotification::ActionFailed {
            id: None,
            action: None,
            ..
        })
    )));
    assert!(!failed
        .events
        .iter()
        .any(|event| matches!(event, GameSessionEvent::OutboundMessage(_))));
    assert!(!failed.events.iter().any(|event| matches!(
        event,
        GameSessionEvent::Notification(GameNotification::ProposalCancelled { id, .. })
            if *id == proposal_id
    )));
    assert_eq!(
        outcome.cradles[holder]
            .queued_game_action_count_for_testing()
            .expect("off-chain queue after failed finalization"),
        2,
        "finalization failure must preserve the complete original queue"
    );

    let retry = outcome.cradles[holder]
        .flush_and_collect(&mut allocator)
        .expect("retry finalization");
    assert_eq!(
        retry
            .events
            .iter()
            .filter(|event| matches!(
                event,
                GameSessionEvent::Notification(GameNotification::ProposalCancelled { id, .. })
                    if *id == proposal_id
            ))
            .count(),
        1,
        "staged cancellation notification must publish exactly once after retry"
    );
    assert!(retry.events.iter().any(|event| matches!(
        event,
        GameSessionEvent::OutboundMessage(bytes)
            if matches!(
                crate::session_phases::peer_wire::decode_peer_message(bytes),
                Ok(PeerMessage::Batch { ref actions, .. })
                    if actions.len() == 2
                        && matches!(actions[0], BatchAction::Propose(_))
                        && matches!(actions[1], BatchAction::CancelProposal(_))
            )
    )));
    assert_eq!(
        outcome.cradles[holder]
            .queued_game_action_count_for_testing()
            .expect("off-chain queue after successful retry"),
        0,
        "successful retry must commit the complete planned queue"
    );
}

fn test_deferred_cheat_preserves_order() {
    let mut allocator = AllocEncoder::new();
    let mut rng = ChaCha8Rng::from_seed([43; 32]);
    let (mut outcome, args_program, holder) = settled_debug_outcome(&mut allocator, &mut rng);

    outcome.cradles[holder]
        .queue_game_action_for_testing(GameAction::Cheat(
            GameID(999),
            Amount::default(),
            Hash::default(),
        ))
        .expect("queue deferred cheat");
    let proposal = debug_proposal(&mut allocator, &args_program);
    outcome.cradles[holder]
        .propose(&mut allocator, &proposal)
        .expect("queue action after deferred cheat");

    let drained = outcome.cradles[holder]
        .flush_and_collect(&mut allocator)
        .expect("batch past deferred cheat");
    assert!(!drained.events.iter().any(|event| matches!(
        event,
        GameSessionEvent::Notification(GameNotification::ActionFailed { .. })
    )));
    assert!(drained.events.iter().any(|event| matches!(
        event,
        GameSessionEvent::OutboundMessage(bytes)
            if matches!(
                crate::session_phases::peer_wire::decode_peer_message(bytes),
                Ok(PeerMessage::Batch { ref actions, .. })
                    if actions.len() == 1 && matches!(actions[0], BatchAction::Propose(_))
            )
    )));
    assert_eq!(
        outcome.cradles[holder]
            .queued_game_action_count_for_testing()
            .expect("off-chain queue after deferred cheat"),
        1,
        "deferred cheat must remain before no other queued action"
    );
}

fn test_shutdown_follows_actual_potato_return_before_trailing_action() {
    let mut allocator = AllocEncoder::new();
    let mut rng = ChaCha8Rng::from_seed([44; 32]);
    let (mut outcome, args_program, holder) = settled_debug_outcome(&mut allocator, &mut rng);
    let peer = holder ^ 1;

    let proposal = debug_proposal(&mut allocator, &args_program);
    outcome.cradles[holder]
        .propose(&mut allocator, &proposal)
        .expect("queue action before shutdown");
    outcome.cradles[holder]
        .queue_game_action_for_testing(GameAction::CleanShutdown)
        .expect("queue deferred shutdown");
    outcome.cradles[holder]
        .queue_game_action_for_testing(GameAction::QueuedCancelProposal(LocalProposalId(999)))
        .expect("queue invalid action after shutdown");

    let first_drain = outcome.cradles[holder]
        .flush_and_collect(&mut allocator)
        .expect("flush action before shutdown");
    let outbound = first_drain
        .events
        .iter()
        .filter_map(|event| match event {
            GameSessionEvent::OutboundMessage(bytes) => Some(bytes),
            _ => None,
        })
        .collect::<Vec<_>>();
    let decoded = outbound
        .iter()
        .map(|bytes| {
            crate::session_phases::peer_wire::decode_peer_message(bytes).expect("decode outbound")
        })
        .collect::<Vec<_>>();
    assert!(matches!(
        decoded.as_slice(),
        [PeerMessage::Batch { actions, .. }, PeerMessage::RequestPotato(())]
            if actions.len() == 1 && matches!(actions[0], BatchAction::Propose(_))
    ));

    for message in outbound {
        outcome.cradles[peer]
            .deliver_message(message)
            .expect("deliver batch and potato request");
    }
    let peer_drain = outcome.cradles[peer]
        .flush_and_collect(&mut allocator)
        .expect("return requested potato");
    let returned_potato = peer_drain
        .events
        .iter()
        .find_map(|event| match event {
            GameSessionEvent::OutboundMessage(bytes) => Some(bytes),
            _ => None,
        })
        .expect("potato return batch");
    assert!(matches!(
        crate::session_phases::peer_wire::decode_peer_message(returned_potato),
        Ok(PeerMessage::Batch { ref actions, .. }) if actions.is_empty()
    ));

    outcome.cradles[holder]
        .deliver_message(returned_potato)
        .expect("deliver returned potato");
    let shutdown_drain = outcome.cradles[holder]
        .flush_and_collect(&mut allocator)
        .expect("process returned potato");
    assert!(!shutdown_drain.events.iter().any(|event| matches!(
        event,
        GameSessionEvent::Notification(GameNotification::ActionFailed { .. })
    )));
    let next_messages = shutdown_drain
        .events
        .iter()
        .filter_map(|event| match event {
            GameSessionEvent::OutboundMessage(bytes) => Some(
                crate::session_phases::peer_wire::decode_peer_message(bytes)
                    .expect("decode shutdown"),
            ),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert!(
        matches!(
            next_messages.as_slice(),
            [PeerMessage::CleanShutdown { .. }]
        ),
        "clean shutdown must be the next message after the requested potato returns"
    );
}

pub(super) fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
    vec![
        (
            "test_atomic_local_batch_failing_action_is_removed_in_place",
            &test_failing_action_is_removed_in_place,
        ),
        (
            "test_atomic_local_batch_finalization_failure_preserves_full_queue",
            &test_finalization_failure_preserves_full_queue,
        ),
        (
            "test_atomic_local_batch_deferred_cheat_preserves_order",
            &test_deferred_cheat_preserves_order,
        ),
        (
            "test_atomic_local_batch_shutdown_follows_actual_potato_return",
            &test_shutdown_follows_actual_potato_return_before_trailing_action,
        ),
    ]
}
