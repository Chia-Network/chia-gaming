use super::{ManagedGameSession, TransactionManager};
use crate::game_session::DrainResult;
use crate::session_phases::effects::GameSessionEventQueue;

/// Transient output excluded from a serialized blockchain-observation working copy.
///
/// Failed observations restore this journal unchanged. Successful observations
/// prepend it to output produced by the committed working copy.
pub(super) struct ObservationTransients {
    pending_events: GameSessionEventQueue,
    pending_watch_coins: Vec<crate::common::types::CoinString>,
    pending_unwatch_coins: Vec<crate::common::types::CoinString>,
    session_output: Option<DrainResult>,
}

impl ObservationTransients {
    pub(super) fn detach<C: ManagedGameSession>(manager: &mut TransactionManager<C>) -> Self {
        Self {
            pending_events: std::mem::take(&mut manager.pending_events),
            pending_watch_coins: std::mem::take(&mut manager.pending_watch_coins),
            pending_unwatch_coins: std::mem::take(&mut manager.pending_unwatch_coins),
            session_output: manager.cradle.session_detach_observation_output(),
        }
    }

    pub(super) fn restore<C: ManagedGameSession>(&mut self, manager: &mut TransactionManager<C>) {
        manager.pending_events = std::mem::take(&mut self.pending_events);
        manager.pending_watch_coins = std::mem::take(&mut self.pending_watch_coins);
        manager.pending_unwatch_coins = std::mem::take(&mut self.pending_unwatch_coins);
        manager
            .cradle
            .session_prepend_observation_output(self.session_output.take());
    }

    pub(super) fn merge<C: ManagedGameSession>(&mut self, working: &mut TransactionManager<C>) {
        self.pending_events.append(&mut working.pending_events);
        self.pending_watch_coins
            .append(&mut working.pending_watch_coins);
        self.pending_unwatch_coins
            .append(&mut working.pending_unwatch_coins);
        working.pending_events = std::mem::take(&mut self.pending_events);
        working.pending_watch_coins = std::mem::take(&mut self.pending_watch_coins);
        working.pending_unwatch_coins = std::mem::take(&mut self.pending_unwatch_coins);
        working
            .cradle
            .session_prepend_observation_output(self.session_output.take());
    }
}
