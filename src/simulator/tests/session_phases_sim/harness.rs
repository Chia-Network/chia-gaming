use crate::common::types::Hash;
use crate::transaction_manager::CoinStateRecord;

use super::*;

const MAX_QUIESCENCE_ROUNDS: usize = 8;

type ProposalMutation =
    Box<dyn FnOnce(&mut crate::session_phases::types::WireProposal) -> Result<(), Error>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct MoveReadinessBoundary {
    action_index: usize,
    player: usize,
    game_id: GameID,
    applied_count: usize,
}

impl MoveReadinessBoundary {
    fn capture(
        action_index: usize,
        player: usize,
        game_id: GameID,
        ui: &LocalTestUIReceiver,
    ) -> Self {
        Self {
            action_index,
            player,
            game_id,
            applied_count: move_application_count(ui, game_id),
        }
    }

    fn is_satisfied(&self, ui: &LocalTestUIReceiver) -> bool {
        move_application_count(ui, self.game_id) > self.applied_count
    }
}

fn move_application_count(ui: &LocalTestUIReceiver, game_id: GameID) -> usize {
    ui.notifications
        .iter()
        .filter(|notification| {
            matches!(
                notification,
                GameNotification::LocalActionApplied {
                    id,
                    action: LocalActionKind::MakeMove,
                } if id == &game_id
            )
        })
        .count()
}

#[derive(Default, Debug)]
pub(super) struct DrainProgress {
    events: usize,
    messages: usize,
    callbacks: usize,
    terminal_handoffs: usize,
    submissions: usize,
}

impl DrainProgress {
    fn made_progress(&self) -> bool {
        self.events > 0
            || self.messages > 0
            || self.callbacks > 0
            || self.terminal_handoffs > 0
            || self.submissions > 0
    }

    fn merge(&mut self, other: DrainProgress) {
        self.events += other.events;
        self.messages += other.messages;
        self.callbacks += other.callbacks;
        self.terminal_handoffs += other.terminal_handoffs;
        self.submissions += other.submissions;
    }
}

pub(super) struct SimulationHarness {
    cradles: [TransactionManager<GameSession>; 2],
    simulator: Simulator,
    local_uis: [LocalTestUIReceiver; 2],
    logs: [Vec<String>; 2],
    report_backlogs: [Vec<(usize, Vec<CoinStateRecord>)>; 2],
    blocked_coin_reports_for: u8,
    force_destroyed_coins: Vec<CoinString>,
    wait_blocks: Option<(usize, usize)>,
    nerf_transactions_for: u8,
    nerf_messages_for: u8,
    tamper_next_batch_signature: [bool; 2],
    pending_proposal_mutations: [Option<ProposalMutation>; 2],
    nerfed_tx_backlog: Vec<SpendBundle>,
    timing_enabled: bool,
    step_started: std::time::Instant,
    start_step: usize,
    num_steps: usize,
    host_watched_coins: [HashSet<CoinString>; 2],
    host_events: [Vec<HostBoundaryEvent>; 2],
    move_readiness_boundary: Option<MoveReadinessBoundary>,
    pending_received_proposal_refs: [VecDeque<ScriptProposalRef>; 2],
}

impl SimulationHarness {
    fn resolved_game_id(&self, player: usize, game: ScriptGameRef) -> Option<GameID> {
        match game {
            ScriptGameRef::AcceptedMember { .. } => {
                self.local_uis[player].accepted_game_ids.get(&game).copied()
            }
            ScriptGameRef::Missing(id) => Some(id),
        }
    }

    fn game_id(&self, player: usize, game: ScriptGameRef) -> Result<GameID, Error> {
        self.resolved_game_id(player, game).ok_or_else(|| {
            Error::StrErr(format!(
                "player {player} has not bound accepted game reference {game:?}"
            ))
        })
    }

    fn bind_proposal_reference(
        &mut self,
        player: usize,
        reference: ScriptProposalRef,
        local_id: LocalProposalId,
    ) {
        let previous = self.local_uis[player]
            .proposal_bindings
            .insert(reference, local_id);
        assert!(
            previous.is_none(),
            "player {player} rebound proposal reference {reference:?} from {previous:?} to {local_id:?}"
        );
        let previous = self.local_uis[player]
            .proposal_refs_by_id
            .insert(local_id, reference);
        assert!(
            previous.is_none(),
            "player {player} rebound local proposal {local_id:?} from {previous:?} to {reference:?}"
        );
    }

    fn bind_next_proposal_reference(
        &mut self,
        player: usize,
        reference: ScriptProposalRef,
    ) -> bool {
        if self.local_uis[player]
            .proposal_bindings
            .contains_key(&reference)
        {
            return true;
        }
        let Some(local_id) = self.local_uis[player].unbound_proposal_ids.pop_front() else {
            return false;
        };
        self.bind_proposal_reference(player, reference, local_id);
        true
    }

    fn bind_next_proposal_for_both(&mut self, player: usize, reference: ScriptProposalRef) -> bool {
        if !self.bind_next_proposal_reference(player, reference) {
            return false;
        }
        self.bind_next_proposal_reference(player ^ 1, reference);
        true
    }

    fn local_proposal_id(
        &mut self,
        player: usize,
        proposal: ScriptProposalRef,
    ) -> Result<LocalProposalId, Error> {
        self.bind_next_proposal_for_both(player, proposal);
        self.local_uis[player]
            .proposal_bindings
            .get(&proposal)
            .copied()
            .ok_or_else(|| {
                Error::StrErr(format!(
                    "player {player} has not observed proposal reference {proposal:?}"
                ))
            })
    }

    fn expect_accepted_members(&mut self, proposal: ScriptProposalRef) {
        let expected_member_count = self
            .local_uis
            .iter()
            .find_map(|ui| {
                ui.proposal_bindings
                    .get(&proposal)
                    .and_then(|local_id| ui.proposal_member_counts.get(local_id))
            })
            .copied()
            .unwrap_or_else(|| {
                panic!("no script-known member count for accepted proposal {proposal:?}")
            });
        let expected = (0..expected_member_count)
            .map(|member| ScriptGameRef::AcceptedMember { proposal, member });
        for ui in &mut self.local_uis {
            ui.expected_accepted_game_refs.extend(expected.clone());
        }
    }

    pub(super) fn new(
        cradles: [TransactionManager<GameSession>; 2],
        simulator: Simulator,
        local_uis: [LocalTestUIReceiver; 2],
    ) -> Self {
        Self {
            cradles,
            simulator,
            local_uis,
            logs: [Vec::new(), Vec::new()],
            report_backlogs: [Vec::new(), Vec::new()],
            blocked_coin_reports_for: 0,
            force_destroyed_coins: Vec::new(),
            wait_blocks: None,
            nerf_transactions_for: 0,
            nerf_messages_for: 0,
            tamper_next_batch_signature: [false, false],
            pending_proposal_mutations: [None, None],
            nerfed_tx_backlog: Vec::new(),
            timing_enabled: std::env::var("SIM_TIMING").is_ok(),
            step_started: std::time::Instant::now(),
            start_step: 0,
            num_steps: 0,
            host_watched_coins: [HashSet::new(), HashSet::new()],
            host_events: [Vec::new(), Vec::new()],
            move_readiness_boundary: None,
            pending_received_proposal_refs: [VecDeque::new(), VecDeque::new()],
        }
    }

    pub(super) fn local_uis(&self) -> &[LocalTestUIReceiver; 2] {
        &self.local_uis
    }

    pub(super) fn begin_step(&mut self, move_number: usize, next: Option<&SimScriptAction>) {
        self.num_steps += 1;
        let handshake = self.cradles.each_ref().map(|c| c.handshake_finished());
        let channel_created = self.local_uis.each_ref().map(|ui| ui.channel_created);
        assert!(
            self.num_steps < 200,
            "simulation stalled: num_steps={} move_number={move_number} next_action={next:?} handshake_finished={handshake:?} channel_created={channel_created:?}",
            self.num_steps
        );
        if matches!(self.wait_blocks, Some((0, _))) {
            self.wait_blocks = None;
        }
    }

    pub(super) fn finish_step_timing(&mut self, move_number: usize) {
        if self.timing_enabled {
            let elapsed = self.step_started.elapsed();
            if elapsed.as_millis() > 50 {
                eprintln!(
                    "  step {} TOTAL: {elapsed:.2?} (move_number={move_number})",
                    self.num_steps
                );
            }
        }
        self.step_started = std::time::Instant::now();
    }

    pub(super) fn early_success(
        &self,
        pred: &GameRunEarlySuccessPredicate,
        move_number: usize,
    ) -> bool {
        pred.as_ref()
            .is_some_and(|predicate| predicate(move_number, &self.cradles))
    }

    pub(super) fn establish_readiness_boundary(
        &mut self,
        action_index: usize,
        readiness: ActionReadiness,
    ) {
        match readiness {
            ActionReadiness::AcceptProposal { player, proposal }
            | ActionReadiness::ProposalExists { player, proposal }
            | ActionReadiness::ProposalKnown { player, proposal } => {
                self.bind_next_proposal_for_both(player, proposal);
            }
            _ => {}
        }
        let ActionReadiness::MoveApplied { player, game } = readiness else {
            self.move_readiness_boundary = None;
            return;
        };
        if self
            .move_readiness_boundary
            .is_some_and(|boundary| boundary.action_index == action_index)
        {
            return;
        }
        let Some(game_id) = self.resolved_game_id(player, game) else {
            self.move_readiness_boundary = None;
            return;
        };
        self.move_readiness_boundary = Some(MoveReadinessBoundary::capture(
            action_index,
            player,
            game_id,
            &self.local_uis[player],
        ));
    }

    pub(super) fn readiness_satisfied(
        &self,
        action_index: usize,
        readiness: ActionReadiness,
    ) -> bool {
        match readiness {
            ActionReadiness::Immediate => true,
            ActionReadiness::GameCanMove { player, game } => {
                self.resolved_game_id(player, game).is_some_and(|game_id| {
                    self.local_uis[player].game_accepted_ids.contains(&game_id)
                        || self.local_uis[player]
                            .opponent_moved_in_game
                            .contains(&game_id)
                })
            }
            ActionReadiness::AcceptProposal { player, proposal } => {
                if self.local_uis[player]
                    .accepted_proposal_ids
                    .contains(&proposal)
                {
                    let local_id = self.local_uis[player]
                        .proposal_bindings
                        .get(&proposal)
                        .copied();
                    self.local_uis[player].accepted_game_ids.keys().any(|game| {
                        matches!(
                            game,
                            ScriptGameRef::AcceptedMember {
                                proposal: bound,
                                ..
                            } if *bound == proposal
                        )
                    }) || self.local_uis[player].notifications.iter().any(|n| {
                            matches!(n, GameNotification::InsufficientBalance { id, .. } if Some(*id) == local_id)
                                || matches!(
                                    n,
                                    GameNotification::ProposalCancelled { id, .. }
                                        if Some(*id) == local_id
                                )
                        })
                } else {
                    self.local_uis[player]
                        .proposal_bindings
                        .contains_key(&proposal)
                }
            }
            ActionReadiness::ChannelReady { player } => self.local_uis[player].channel_created,
            ActionReadiness::ProposalExists { player, proposal } => self.local_uis[player]
                .proposal_bindings
                .contains_key(&proposal),
            ActionReadiness::ProposalKnown { player, proposal } => {
                self.local_uis[player]
                    .proposal_bindings
                    .contains_key(&proposal)
                    || self.local_uis[player]
                        .accepted_proposal_ids
                        .contains(&proposal)
            }
            ActionReadiness::MoveApplied { player, game } => {
                let Some(game_id) = self.resolved_game_id(player, game) else {
                    return false;
                };
                let boundary = self
                    .move_readiness_boundary
                    .expect("move readiness boundary must be established before evaluation");
                assert_eq!(
                    (boundary.action_index, boundary.player, boundary.game_id),
                    (action_index, player, game_id),
                    "move readiness boundary does not match current action"
                );
                boundary.is_satisfied(&self.local_uis[player])
            }
            ActionReadiness::NerfedTransactionAvailable => !self.nerfed_tx_backlog.is_empty(),
            ActionReadiness::AfterGame { game } => self.local_uis.iter().any(|ui| {
                ui.accepted_game_ids
                    .get(&game)
                    .is_some_and(|game_id| ui.game_finished_ids.contains(game_id))
            }),
        }
    }

    pub(super) fn wait_active(&self) -> bool {
        self.wait_blocks.is_some()
    }

    pub(super) fn advance_wait(&mut self, allocator: &mut AllocEncoder) -> Result<(), Error> {
        let Some((blocks, _)) = &mut self.wait_blocks else {
            return Ok(());
        };
        for player in 0..=1 {
            for (height, records) in &self.report_backlogs[player] {
                self.cradles[player].report_coin_states(allocator, *height as u64, records)?;
            }
            self.report_backlogs[player].clear();
        }
        if *blocks > 0 {
            *blocks -= 1;
        }
        Ok(())
    }

    pub(super) fn handshake_checkpoint(&mut self, handshake_done: &mut bool) -> bool {
        if !*handshake_done && self.cradles.iter().all(|c| c.handshake_finished()) {
            if self.start_step == 0 {
                self.start_step += 1;
                return true;
            }
            *handshake_done = true;
        }
        false
    }

    pub(super) fn fully_resolved(&self) -> bool {
        self.cradles.iter().enumerate().all(|(player, cradle)| {
            cradle.is_fully_resolved() && self.local_uis[player].lifecycle_oracle_satisfied()
        })
    }

    pub(super) fn any_on_chain(&self) -> bool {
        self.cradles.iter().any(|cradle| cradle.is_on_chain())
    }

    pub(super) fn pump_block(
        &mut self,
        allocator: &mut AllocEncoder,
        identities: &[ChiaIdentity],
        launcher_coin: &CoinString,
        neutral_identity: &ChiaIdentity,
        has_explicit_go_on_chain: bool,
        move_number: usize,
        next_action: Option<&SimScriptAction>,
        pred: &GameRunEarlySuccessPredicate,
    ) -> Result<(DrainProgress, bool), Error> {
        let started = std::time::Instant::now();
        self.simulator.farm_block(&neutral_identity.puzzle_hash);
        let current_height = self.simulator.get_current_height();
        if self.timing_enabled {
            eprintln!(
                "  step {}: farm_block {:.2?}",
                self.num_steps,
                started.elapsed()
            );
        }
        let destroyed: HashSet<CoinString> = self.force_destroyed_coins.drain(..).collect();
        let mut progress = DrainProgress::default();
        if self.early_success(pred, move_number) {
            return Ok((progress, true));
        }
        for player in 0..=1 {
            if self.local_uis[player].go_on_chain && self.cradles[player].is_on_chain() {
                self.local_uis[player].go_on_chain = false;
            } else if self.local_uis[player].go_on_chain
                && self.cradles[player].handshake_finished()
            {
                if !has_explicit_go_on_chain && !self.local_uis[player].got_error {
                    panic!(
                        "unexpected off-chain->on-chain transition: player={player} move_number={move_number} next_action={next_action:?}"
                    );
                }
                self.local_uis[player].go_on_chain = false;
                self.cradles[player].go_on_chain(allocator, self.local_uis[player].got_error)?;
            }

            let watched_coins = self.host_watched_coins[player]
                .iter()
                .cloned()
                .collect::<Vec<_>>();
            let mut records = self.simulator.get_coin_states(&watched_coins);
            for record in &mut records {
                if destroyed.contains(&record.coin) {
                    record.spent_height = Some(current_height as u64);
                }
            }
            let wait_blocked = self
                .wait_blocks
                .is_some_and(|(_, players)| players & (1 << player) != 0);
            if wait_blocked || self.blocked_coin_reports_for & (1 << player) != 0 {
                self.report_backlogs[player].push((current_height, records));
            } else {
                self.cradles[player].report_coin_states(
                    allocator,
                    current_height as u64,
                    &records,
                )?;
            }
            progress.merge(self.drain_player(
                allocator,
                player,
                identities,
                launcher_coin,
                self.timing_enabled,
                self.num_steps,
            )?);
        }
        Ok((progress, false))
    }

    pub(super) fn assert_game_coin_submitted(
        &self,
        player: usize,
        game: ScriptGameRef,
    ) -> (CoinString, usize) {
        let game_id = self
            .game_id(player, game)
            .expect("game publication assertion requires an accepted member");
        let coin = self.cradles[player]
            .get_game_coin(&game_id)
            .unwrap_or_else(|| panic!("player {player} has no current coin for game {game_id:?}"));
        assert!(
            self.simulator.mempool_spends_coin(&coin.to_coin_id()),
            "mempool does not spend player {player}'s current coin for game {game_id:?}: {coin:?}"
        );
        (coin, self.simulator.get_current_height())
    }

    pub(super) fn assert_game_coin_child_published(
        &self,
        player: usize,
        game: ScriptGameRef,
        parent: &CoinString,
        submitted_height: usize,
    ) {
        let game_id = self
            .game_id(player, game)
            .expect("game child assertion requires an accepted member");
        let current_height = self.simulator.get_current_height();
        assert_eq!(
            current_height,
            submitted_height + 1,
            "game coin was not observed on the first block after submission"
        );
        let child = self.cradles[player]
            .get_game_coin(&game_id)
            .unwrap_or_else(|| panic!("player {player} has no child coin for game {game_id:?}"));
        let (child_parent, _, _) = child
            .to_parts()
            .unwrap_or_else(|| panic!("child game coin has no parts: {child:?}"));
        assert_eq!(
            child_parent,
            parent.to_coin_id(),
            "observed game coin is not the submitted coin's child"
        );
        let (created_height, _) = self
            .simulator
            .coin_heights(&child.to_coin_id())
            .unwrap_or_else(|| panic!("child game coin is absent from simulator: {child:?}"));
        assert_eq!(created_height as usize, submitted_height + 1);
    }

    pub(super) fn assert_game_coin_timeout_registered(&self, player: usize, game: ScriptGameRef) {
        let game_id = self
            .game_id(player, game)
            .expect("timeout assertion requires an accepted member");
        let coin = self.cradles[player]
            .get_game_coin(&game_id)
            .unwrap_or_else(|| panic!("player {player} has no current coin for game {game_id:?}"));
        let watched = self.cradles[player].watched_coin(&coin).unwrap_or_else(|| {
            panic!("player {player} is not watching the current coin for game {game_id:?}")
        });
        assert!(
            watched.timeout_spend.is_some(),
            "player {player} has no timeout spend registered for game {game_id:?}"
        );
    }

    pub(super) fn make_move(
        &mut self,
        allocator: &mut AllocEncoder,
        player: usize,
        game: &ScriptGameRef,
        readable: ReadableMove,
        entropy: Hash,
    ) -> Result<(), Error> {
        let game_id = self.game_id(player, *game)?;
        self.cradles[player].make_move(allocator, &game_id, readable, entropy)?;
        for ui in &mut self.local_uis {
            ui.game_accepted_ids.remove(&game_id);
        }
        self.local_uis[player]
            .opponent_moved_in_game
            .remove(&game_id);
        Ok(())
    }

    pub(super) fn propose(
        &mut self,
        allocator: &mut AllocEncoder,
        player: usize,
        reference: Option<ScriptProposalRef>,
        proposals: &[GameProposal],
        expected_member_count: usize,
    ) -> Result<(), Error> {
        let [proposal] = proposals else {
            return Err(Error::StrErr(format!(
                "simulator proposal helper expects one request, got {}",
                proposals.len()
            )));
        };
        let local_id = self.cradles[player].propose(allocator, proposal)?;
        self.local_uis[player].proposed_game_ids.push(local_id);
        self.local_uis[player]
            .proposal_member_counts
            .insert(local_id, expected_member_count);
        if let Some(reference) = reference {
            self.bind_proposal_reference(player, reference, local_id);
            self.pending_received_proposal_refs[player ^ 1].push_back(reference);
        } else {
            self.local_uis[player]
                .unbound_proposal_ids
                .push_back(local_id);
        }
        Ok(())
    }

    pub(super) fn accept_proposal(
        &mut self,
        allocator: &mut AllocEncoder,
        player: usize,
        proposal: &ScriptProposalRef,
    ) -> Result<bool, Error> {
        if self.local_uis[player]
            .accepted_proposal_ids
            .contains(proposal)
        {
            return Ok(false);
        }
        let local_id = self.local_proposal_id(player, *proposal)?;
        self.cradles[player].accept_proposal(allocator, &local_id)?;
        self.local_uis[player]
            .accepted_proposal_ids
            .insert(*proposal);
        self.expect_accepted_members(*proposal);
        Ok(true)
    }

    pub(super) fn accept_proposal_pair(
        &mut self,
        allocator: &mut AllocEncoder,
        player: usize,
        first: &ScriptProposalRef,
        second: &ScriptProposalRef,
    ) -> Result<bool, Error> {
        if self.local_uis[player].accepted_proposal_ids.contains(first)
            && self.local_uis[player]
                .accepted_proposal_ids
                .contains(second)
        {
            return Ok(false);
        }
        game_assert!(
            !self.local_uis[player].accepted_proposal_ids.contains(first)
                && !self.local_uis[player]
                    .accepted_proposal_ids
                    .contains(second),
            "paired acceptance was only partially queued"
        );
        let first_local = self.local_proposal_id(player, *first)?;
        let second_local = self.local_proposal_id(player, *second)?;
        self.cradles[player].accept_proposal(allocator, &first_local)?;
        self.cradles[player].accept_proposal(allocator, &second_local)?;
        self.local_uis[player]
            .accepted_proposal_ids
            .extend([*first, *second]);
        self.expect_accepted_members(*first);
        self.expect_accepted_members(*second);
        Ok(true)
    }

    pub(super) fn malformed_accept_proposal(
        &mut self,
        allocator: &mut AllocEncoder,
        player: usize,
        proposal: &ScriptProposalRef,
        wire_proposal_id: &WireProposalId,
    ) -> Result<bool, Error> {
        if !self.accept_proposal(allocator, player, proposal)? {
            return Ok(false);
        }
        self.cradles[player].flush_pending(allocator)?;
        self.cradles[player].replace_last_message(|message| {
            let PeerMessage::Batch {
                actions,
                signatures,
            } = message
            else {
                return Err(Error::StrErr(format!(
                    "malformed accept expected Batch, got {message:?}"
                )));
            };
            let mut actions = actions.clone();
            let proposal_id = actions.iter_mut().find_map(|action| match action {
                BatchAction::AcceptProposal(id) => Some(id),
                _ => None,
            });
            let Some(proposal_id) = proposal_id else {
                return Err(Error::StrErr(
                    "malformed accept found no AcceptProposal".to_string(),
                ));
            };
            *proposal_id = *wire_proposal_id;
            Ok(PeerMessage::Batch {
                actions,
                signatures: signatures.clone(),
            })
        })?;
        Ok(true)
    }

    pub(super) fn malformed_second_accept_in_pair(
        &mut self,
        allocator: &mut AllocEncoder,
        player: usize,
        first: &ScriptProposalRef,
        second: &ScriptProposalRef,
        replacement_wire_id: &WireProposalId,
    ) -> Result<bool, Error> {
        if !self.accept_proposal_pair(allocator, player, first, second)? {
            return Ok(false);
        }
        self.cradles[player].flush_pending(allocator)?;
        self.cradles[player].replace_last_message(|message| {
            let PeerMessage::Batch {
                actions,
                signatures,
            } = message
            else {
                return Err(Error::StrErr(format!(
                    "malformed paired accept expected Batch, got {message:?}"
                )));
            };
            let mut actions = actions.clone();
            let second_proposal_id = actions
                .iter_mut()
                .filter_map(|action| match action {
                    BatchAction::AcceptProposal(id) => Some(id),
                    _ => None,
                })
                .nth(1)
                .ok_or_else(|| {
                    Error::StrErr(
                        "malformed paired accept found fewer than two acceptances".to_string(),
                    )
                })?;
            *second_proposal_id = *replacement_wire_id;
            Ok(PeerMessage::Batch {
                actions,
                signatures: signatures.clone(),
            })
        })?;
        Ok(true)
    }

    pub(super) fn cancel_proposal(
        &mut self,
        allocator: &mut AllocEncoder,
        player: usize,
        proposal: &ScriptProposalRef,
    ) -> Result<(), Error> {
        let local_id = self.local_proposal_id(player, *proposal)?;
        if !self.local_uis[player].proposed_game_ids.contains(&local_id) {
            self.local_uis[player]
                .silently_rejected_proposal_ids
                .insert(local_id);
        }
        self.cradles[player].cancel_proposal(allocator, &local_id)
    }

    pub(super) fn go_on_chain(
        &mut self,
        allocator: &mut AllocEncoder,
        player: usize,
        move_number: usize,
    ) -> Result<bool, Error> {
        assert!(
            !self.cradles[player].channel_status_terminal(),
            "GoOnChain({player}) but channel is terminal: move_number={move_number} notifications={:?}",
            self.local_uis[player].notifications
        );
        assert!(
            !self.cradles[player].is_on_chain(),
            "GoOnChain({player}) but player is already on chain"
        );
        if !self.cradles[player].handshake_finished() {
            return Ok(false);
        }
        self.cradles[player].go_on_chain(allocator, false)?;
        Ok(true)
    }

    pub(super) fn sabotage_move(
        &mut self,
        allocator: &mut AllocEncoder,
        player: usize,
        game: &ScriptGameRef,
        readable: ReadableMove,
        entropy: Hash,
        move_data: &[u8],
    ) -> Result<(), Error> {
        self.make_move(allocator, player, game, readable, entropy)?;
        self.cradles[player].flush_pending(allocator)?;
        self.cradles[player].replace_last_message(|message| {
            let PeerMessage::Batch {
                actions,
                signatures,
            } = message
            else {
                return Err(Error::StrErr(format!(
                    "FakeMove expected Batch, got {message:?}"
                )));
            };
            let mut actions = actions.clone();
            let move_action = actions.iter_mut().find_map(|action| match action {
                BatchAction::Move(_, data) => Some(data),
                _ => None,
            });
            let Some(move_action) = move_action else {
                return Err(Error::StrErr("FakeMove found no Move action".to_string()));
            };
            move_action.move_made.extend_from_slice(move_data);
            Ok(PeerMessage::Batch {
                actions,
                signatures: signatures.clone(),
            })
        })
    }

    pub(super) fn tamper_next_batch_signature(&mut self, player: usize) {
        self.tamper_next_batch_signature[player] = true;
    }

    pub(super) fn cheat(
        &mut self,
        allocator: &mut AllocEncoder,
        player: usize,
        game: &ScriptGameRef,
        share: Amount,
    ) -> Result<(), Error> {
        let game_id = self.game_id(player, *game)?;
        self.cradles[player].cheat(allocator, &game_id, share)
    }

    pub(super) fn force_destroy_coin(&mut self, player: usize, game: &ScriptGameRef) -> bool {
        let Some(game_id) = self.resolved_game_id(player, *game) else {
            return false;
        };
        let Some(coin) = self.cradles[player].get_game_coin(&game_id) else {
            return false;
        };
        self.force_destroyed_coins.push(coin);
        true
    }

    pub(super) fn nerf_transactions(&mut self, player: usize) {
        self.nerf_transactions_for |= 1 << player;
    }

    pub(super) fn unnerf_transactions_for(&mut self, player: usize) {
        self.nerf_transactions_for &= !(1 << player);
    }

    pub(super) fn unnerf_transactions(
        &mut self,
        allocator: &mut AllocEncoder,
        replay: bool,
    ) -> Result<(), Error> {
        self.nerf_transactions_for = 0;
        if !replay {
            self.nerfed_tx_backlog.clear();
            return Ok(());
        }
        for tx in self.nerfed_tx_backlog.drain(..) {
            if tx
                .spends
                .iter()
                .any(|spend| !self.simulator.is_coin_spendable(&spend.coin))
            {
                continue;
            }
            self.simulator.push_transactions(allocator, &tx.spends)?;
        }
        Ok(())
    }

    pub(super) fn mutate_nerfed_shutdown_solution(
        &mut self,
        allocator: &mut AllocEncoder,
    ) -> Result<(), Error> {
        game_assert!(
            !self.nerfed_tx_backlog.is_empty(),
            "no nerfed shutdown transaction"
        );
        for tx in &mut self.nerfed_tx_backlog {
            for coin_spend in &mut tx.spends {
                let spend = &mut coin_spend.bundle;
                let solution_node = spend.solution.p().to_nodeptr(allocator)?;
                let elements =
                    crate::utils::proper_list(allocator.allocator(), solution_node, true)
                        .filter(|elements| elements.len() == 3)
                        .ok_or_else(|| {
                            Error::StrErr(
                                "clean shutdown standard solution must contain three items"
                                    .to_string(),
                            )
                        })?;
                let delegated_puzzle = Program::from_nodeptr(allocator, elements[1])?;
                let one = 1.to_clvm(allocator).into_gen()?;
                let modified = crate::common::standard_coin::solution_for_delegated_puzzle(
                    allocator,
                    delegated_puzzle,
                    one,
                )?;
                spend.solution = Program::from_nodeptr(allocator, modified)?.into();
            }
        }
        Ok(())
    }

    pub(super) fn block_coin_reports(&mut self, player: usize) {
        self.blocked_coin_reports_for |= 1 << player;
    }

    pub(super) fn unblock_coin_reports(
        &mut self,
        allocator: &mut AllocEncoder,
        replay: bool,
    ) -> Result<(), Error> {
        self.blocked_coin_reports_for = 0;
        if replay {
            for player in 0..=1 {
                for (height, records) in &self.report_backlogs[player] {
                    self.cradles[player].report_coin_states(allocator, *height as u64, records)?;
                }
                self.report_backlogs[player].clear();
            }
        } else {
            self.report_backlogs = [Vec::new(), Vec::new()];
        }
        Ok(())
    }

    pub(super) fn nerf_messages(&mut self, player: usize) {
        self.nerf_messages_for |= 1 << player;
    }

    pub(super) fn unnerf_messages(&mut self) {
        self.nerf_messages_for = 0;
    }

    pub(super) fn wait_blocks(&mut self, blocks: usize, players: usize) {
        self.wait_blocks = Some((blocks, players));
    }

    pub(super) fn accept_settlement(
        &mut self,
        allocator: &mut AllocEncoder,
        player: usize,
        game: &ScriptGameRef,
    ) -> Result<(), Error> {
        let game_id = self.game_id(player, *game)?;
        self.cradles[player].accept_settlement(allocator, &game_id)
    }

    pub(super) fn clean_shutdown(
        &mut self,
        allocator: &mut AllocEncoder,
        player: usize,
    ) -> Result<bool, Error> {
        assert!(
            !self.cradles[player].is_on_chain(),
            "CleanShutdown({player}) called while on chain"
        );
        if !self.cradles[player].handshake_finished() {
            return Ok(false);
        }
        self.cradles[player].shut_down(allocator)?;
        Ok(true)
    }

    pub(super) fn corrupt_state_number(
        &mut self,
        player: usize,
        state_number: usize,
    ) -> Result<(), Error> {
        self.cradles[player].corrupt_state_for_testing(state_number)
    }

    pub(super) fn force_unroll(
        &mut self,
        allocator: &mut AllocEncoder,
        player: usize,
    ) -> Result<(), Error> {
        let spend = self.cradles[player].force_unroll_spend(allocator)?;
        self.simulator.push_transactions(allocator, &spend.spends)?;
        Ok(())
    }

    pub(super) fn save_unroll_snapshot(&mut self, player: usize) {
        self.cradles[player].save_unroll_snapshot();
    }

    pub(super) fn force_stale_unroll(
        &mut self,
        allocator: &mut AllocEncoder,
        player: usize,
    ) -> Result<(), Error> {
        let spend = self.cradles[player].force_stale_unroll_spend(allocator)?;
        self.simulator.push_transactions(allocator, &spend.spends)?;
        Ok(())
    }

    pub(super) fn inject_raw_message(&mut self, player: usize, data: &[u8]) -> Result<(), Error> {
        self.cradles[player].deliver_message(data)
    }

    pub(super) fn self_accept_proposal(
        &mut self,
        allocator: &mut AllocEncoder,
        player: usize,
        proposal: &ScriptProposalRef,
    ) -> Result<(), Error> {
        let local_id = self.local_proposal_id(player, *proposal)?;
        self.cradles[player].self_accept_proposal(allocator, &local_id)
    }

    pub(super) fn mutate_last_proposal(
        &mut self,
        player: usize,
        mutation: impl FnOnce(&mut crate::session_phases::types::WireProposal) -> Result<(), Error>
            + 'static,
    ) -> Result<(), Error> {
        game_assert!(
            self.pending_proposal_mutations[player].is_none(),
            "proposal mutation already pending for player {player}"
        );
        self.pending_proposal_mutations[player] = Some(Box::new(mutation));
        Ok(())
    }

    pub(super) fn drain_to_quiescence(
        &mut self,
        allocator: &mut AllocEncoder,
        identities: &[ChiaIdentity],
        launcher_coin: &CoinString,
    ) -> Result<DrainProgress, Error> {
        let mut total = DrainProgress::default();
        for _ in 0..MAX_QUIESCENCE_ROUNDS {
            let mut round = DrainProgress::default();
            for player in 0..=1 {
                round.merge(self.drain_player(
                    allocator,
                    player,
                    identities,
                    launcher_coin,
                    self.timing_enabled,
                    self.num_steps,
                )?);
            }
            if !round.made_progress() {
                return Ok(total);
            }
            total.merge(round);
        }
        panic!(
            "simulator failed to quiesce after {MAX_QUIESCENCE_ROUNDS} rounds at step {}; progress={total:?}",
            self.num_steps
        );
    }

    pub(super) fn drain_player(
        &mut self,
        allocator: &mut AllocEncoder,
        player_index: usize,
        identities: &[ChiaIdentity],
        _launcher_coin: &CoinString,
        timing_enabled: bool,
        num_steps: usize,
    ) -> Result<DrainProgress, Error> {
        let mut progress = DrainProgress::default();
        let (first, second) = self.cradles.split_at_mut(1);
        let (player, opponent) = if player_index == 0 {
            (&mut first[0], &mut second[0])
        } else {
            (&mut second[0], &mut first[0])
        };

        let result = player.flush_and_collect(allocator)?;
        self.host_events[player_index].push(HostBoundaryEvent::ManagerDrain(HostDrainTrace {
            terminal: player.is_fully_resolved(),
            notifications: result
                .events
                .iter()
                .filter_map(|event| {
                    if let GameSessionEvent::Notification(notification) = event {
                        Some(notification.clone())
                    } else {
                        None
                    }
                })
                .collect(),
        }));
        for coin in result.watch_coins {
            self.host_watched_coins[player_index].insert(coin.clone());
            self.host_events[player_index].push(HostBoundaryEvent::WatchCoin(coin));
        }
        for coin in result.unwatch_coins {
            self.host_watched_coins[player_index].remove(&coin);
        }
        let mut terminal_command = player
            .pending_terminal_handoff()
            .map(|command| command.message);
        let mut pending_events = result.events;
        let mut submissions_to_push = Vec::new();
        let mut deferred_notifications = Vec::new();

        loop {
            progress.events += pending_events.len();
            let mut coin_requests = Vec::new();
            let mut coin_spend_req: Option<CoinSpendRequest> = None;

            for event in &pending_events {
                match event {
                    GameSessionEvent::NeedCoinSpend(req) => {
                        coin_spend_req = Some(req.clone());
                    }
                    GameSessionEvent::OutboundTransaction(submission) => {
                        submissions_to_push.push(submission.bundle.clone());
                    }
                    GameSessionEvent::OutboundMessage(msg) => {
                        if self.nerf_messages_for & (1 << player_index) != 0
                            || player.is_peer_disconnected()
                        {
                            continue;
                        }
                        let should_decode = self.pending_proposal_mutations[player_index].is_some()
                            || self.tamper_next_batch_signature[player_index];
                        let delivered_msg = if should_decode {
                            let mut peer_message =
                                crate::session_phases::peer_wire::decode_peer_message(msg)?;
                            if let PeerMessage::Batch {
                                actions,
                                signatures,
                            } = &mut peer_message
                            {
                                if self.pending_proposal_mutations[player_index].is_some()
                                    && actions
                                        .iter()
                                        .any(|action| matches!(action, BatchAction::Propose(_)))
                                {
                                    let mutation = self.pending_proposal_mutations[player_index]
                                        .take()
                                        .expect("proposal mutation checked as pending");
                                    let proposal = actions
                                        .iter_mut()
                                        .find_map(|action| match action {
                                            BatchAction::Propose(wire) => Some(wire),
                                            _ => None,
                                        })
                                        .expect("proposal action checked as present");
                                    mutation(proposal)?;
                                }
                                if self.tamper_next_batch_signature[player_index] {
                                    signatures.channel_half_sig = Default::default();
                                    self.tamper_next_batch_signature[player_index] = false;
                                }
                            }
                            crate::session_phases::peer_wire::encode_peer_message(&peer_message)?
                        } else {
                            msg.clone()
                        };
                        let started = std::time::Instant::now();
                        opponent.deliver_message(&delivered_msg)?;
                        progress.messages += 1;
                        if timing_enabled && started.elapsed().as_millis() > 10 {
                            eprintln!(
                                "  step {num_steps}: p{player_index}->p{} deliver_message {:.2?}",
                                player_index ^ 1,
                                started.elapsed()
                            );
                        }
                    }
                    GameSessionEvent::OutboundTerminalMessage(_) => {
                        return Err(Error::StrErr(
                            "terminal handoff bypassed TransactionManager disposition".to_string(),
                        ));
                    }
                    GameSessionEvent::Notification(notification) => {
                        if let GameNotification::ProposalCancelled { id, .. } = notification {
                            if let Some(reference) = self.local_uis[player_index]
                                .proposal_refs_by_id
                                .get(id)
                                .copied()
                            {
                                self.pending_received_proposal_refs[player_index ^ 1]
                                    .retain(|pending| *pending != reference);
                            }
                        }
                        deferred_notifications.push(notification.clone());
                    }
                    GameSessionEvent::ReceiveError(error) => {
                        eprintln!("SIM receive error p{player_index}: {error}");
                        deferred_notifications.push(GameNotification::ChannelStatus(
                            ChannelStatusSnapshot {
                                advisory: Some(format!("error receiving peer message: {error}")),
                                ..ChannelStatusSnapshot::new(ChannelStatus::Failed)
                            },
                        ));
                    }
                    GameSessionEvent::CoinSolutionRequest(coin) => {
                        coin_requests.push(coin.clone());
                        self.host_events[player_index]
                            .push(HostBoundaryEvent::CoinSolutionRequested(coin.clone()));
                    }
                    GameSessionEvent::Log(line) => {
                        self.logs[player_index].push(line.clone());
                    }
                    GameSessionEvent::WatchCoin { .. } => {}
                }
            }

            if let Some(message) = terminal_command.as_ref() {
                if self.nerf_messages_for & (1 << player_index) == 0 {
                    opponent.deliver_message(message)?;
                    player.complete_outbound_terminal_handoff()?;
                    progress.terminal_handoffs += 1;
                }
            }

            let has_followup = coin_spend_req.is_some() || !coin_requests.is_empty();
            if !has_followup {
                break;
            }

            if let Some(req) = coin_spend_req {
                let wallet_bundle = build_wallet_bundle_for_request(
                    allocator,
                    &self.simulator,
                    &identities[player_index],
                    &req,
                )?;
                player.provide_coin_spend_bundle(allocator, wallet_bundle)?;
                progress.callbacks += 1;
            }
            for coin in &coin_requests {
                let puzzle_solution = self
                    .simulator
                    .get_puzzle_and_solution(&coin.to_coin_id())
                    .expect("should work");
                player.report_puzzle_and_solution(
                    allocator,
                    coin,
                    puzzle_solution.as_ref().map(|ps| (&ps.0, &ps.1)),
                )?;
                self.host_events[player_index]
                    .push(HostBoundaryEvent::CoinSolutionCallback(coin.clone()));
                progress.callbacks += 1;
            }

            let follow_up = player.flush_and_collect(allocator)?;
            self.host_events[player_index].push(HostBoundaryEvent::ManagerDrain(HostDrainTrace {
                terminal: player.is_fully_resolved(),
                notifications: follow_up
                    .events
                    .iter()
                    .filter_map(|event| {
                        if let GameSessionEvent::Notification(notification) = event {
                            Some(notification.clone())
                        } else {
                            None
                        }
                    })
                    .collect(),
            }));
            for coin in follow_up.watch_coins {
                self.host_watched_coins[player_index].insert(coin.clone());
                self.host_events[player_index].push(HostBoundaryEvent::WatchCoin(coin));
            }
            for coin in follow_up.unwatch_coins {
                self.host_watched_coins[player_index].remove(&coin);
            }
            terminal_command = player
                .pending_terminal_handoff()
                .map(|command| command.message);
            pending_events = follow_up.events;
        }

        submissions_to_push.extend(
            player
                .drain_submissions()
                .expect("drain_submissions")
                .into_iter()
                .map(|submission| submission.bundle),
        );
        for tx in &submissions_to_push {
            progress.submissions += 1;
            if self.nerf_transactions_for & (1 << player_index) != 0 {
                self.nerfed_tx_backlog.push(tx.clone());
                continue;
            }
            let started = std::time::Instant::now();
            let included = self.simulator.push_transactions(allocator, &tx.spends)?;
            if timing_enabled && started.elapsed().as_millis() > 10 {
                eprintln!(
                    "  step {num_steps}: p{player_index} push_transactions({:?}) {:.2?}",
                    tx.name,
                    started.elapsed()
                );
            }
            let expected_duplicate = included.code == 3 && matches!(included.e, Some(5) | Some(20));
            assert!(
                included.code == 1 || expected_duplicate,
                "tx include failed: tx_name={:?} code={} e={:?} diagnostic={:?}",
                tx.name,
                included.code,
                included.e,
                included.diagnostic
            );
            self.host_events[player_index].push(HostBoundaryEvent::TransactionSubmitted(
                tx.spends
                    .iter()
                    .map(|spend| spend.coin.to_coin_id())
                    .collect(),
            ));
        }

        for notification in deferred_notifications {
            if let GameNotification::ProposalMade { id, .. } = &notification {
                if let Some(reference) =
                    self.pending_received_proposal_refs[player_index].pop_front()
                {
                    self.bind_proposal_reference(player_index, reference, *id);
                }
            }
            let notification_coin_in_mempool = if let GameNotification::GameStatus {
                coin_id: Some(coin),
                ..
            } = &notification
            {
                self.simulator.mempool_spends_coin(&coin.to_coin_id())
            } else {
                false
            };
            self.host_events[player_index].push(HostBoundaryEvent::Notification {
                notification: notification.clone(),
                notification_coin_in_mempool,
            });
            self.local_uis[player_index].notification(&notification)?;
        }

        Ok(progress)
    }

    pub(super) fn into_outcome(self, identities: &[ChiaIdentity]) -> super::GameRunOutcome {
        super::GameRunOutcome {
            identities: [identities[0].clone(), identities[1].clone()],
            cradles: self.cradles,
            local_uis: self.local_uis,
            simulator: self.simulator,
            logs: self.logs,
            host_events: self.host_events,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn harness_readiness_boundary_accepts_only_predicate_data() {
        let _predicate_only_api: fn(&SimulationHarness, usize, ActionReadiness) -> bool =
            SimulationHarness::readiness_satisfied;
    }

    #[test]
    fn repeated_move_wait_requires_an_application_after_its_boundary() {
        let game_id = GameID(1);
        let mut ui = LocalTestUIReceiver::default();
        ui.notifications.push(GameNotification::LocalActionApplied {
            id: game_id,
            action: LocalActionKind::MakeMove,
        });

        let boundary = MoveReadinessBoundary::capture(7, 0, game_id, &ui);
        assert!(
            !boundary.is_satisfied(&ui),
            "an application preceding this wait must not satisfy it"
        );

        ui.notifications.push(GameNotification::LocalActionApplied {
            id: game_id,
            action: LocalActionKind::MakeMove,
        });
        assert!(
            boundary.is_satisfied(&ui),
            "the next application after the wait boundary must satisfy it"
        );
    }

    #[test]
    fn lifecycle_oracle_rejects_missing_acceptance_and_terminal() {
        let proposal = ScriptProposalRef(1);
        let game = ScriptGameRef::AcceptedMember {
            proposal,
            member: 0,
        };

        let mut missing_acceptance = LocalTestUIReceiver::default();
        missing_acceptance.expected_accepted_game_refs.insert(game);
        assert!(
            missing_acceptance
                .lifecycle_oracle_error()
                .is_some_and(|error| error.contains("no runtime binding")),
            "an expected acceptance without a runtime binding must not pass"
        );

        let mut missing_terminal = LocalTestUIReceiver::default();
        missing_terminal.expected_accepted_game_refs.insert(game);
        missing_terminal.accepted_game_ids.insert(game, GameID(7));
        assert!(
            missing_terminal
                .lifecycle_oracle_error()
                .is_some_and(|error| error.contains("exactly one terminal notification, got 0")),
            "an accepted member without a terminal notification must not pass"
        );
    }

    #[test]
    fn lifecycle_oracle_rejects_partial_multi_member_acceptance() {
        let proposal = ScriptProposalRef(1);
        let first = ScriptGameRef::AcceptedMember {
            proposal,
            member: 0,
        };
        let second = ScriptGameRef::AcceptedMember {
            proposal,
            member: 1,
        };
        let mut ui = LocalTestUIReceiver::default();
        ui.expected_accepted_game_refs.extend([first, second]);
        ui.accepted_game_ids.insert(first, GameID(7));
        ui.notifications.push(GameNotification::game_settled(
            GameID(7),
            SettlementOutcome::AcceptSettlement,
            Amount::default(),
            None,
        ));

        assert!(
            ui.lifecycle_oracle_error()
                .is_some_and(|error| error.contains(&format!("{second:?}"))),
            "binding only member 0 of an expected two-member acceptance must not pass"
        );
    }

    #[test]
    fn lifecycle_oracle_rejects_unaccepted_game_settled() {
        let mut ui = LocalTestUIReceiver::default();
        ui.notifications.push(GameNotification::game_settled(
            GameID(7),
            SettlementOutcome::AcceptSettlement,
            Amount::default(),
            None,
        ));

        assert!(
            ui.lifecycle_oracle_error()
                .is_some_and(|error| error.contains("terminal notification for unaccepted member")),
            "GameSettled for an unaccepted member must not pass"
        );
    }

    #[test]
    fn transport_and_callback_progress_keep_quiescence_active() {
        let transport = DrainProgress {
            messages: 1,
            ..DrainProgress::default()
        };
        let callback = DrainProgress {
            callbacks: 1,
            ..DrainProgress::default()
        };
        assert!(transport.made_progress());
        assert!(callback.made_progress());

        let mut combined = DrainProgress::default();
        combined.merge(transport);
        combined.merge(callback);
        assert!(combined.made_progress());
        assert_eq!(combined.messages, 1);
        assert_eq!(combined.callbacks, 1);
    }
}
