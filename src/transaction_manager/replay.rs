use std::collections::HashSet;

use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Serialize, Deserialize)]
pub(super) struct ReplayEpoch {
    rollback_height: Option<u64>,
    replayed_submission_ids: HashSet<u64>,
}

impl ReplayEpoch {
    pub(super) fn validate(&self, retained_ids: &HashSet<u64>) -> Result<(), String> {
        if let Some(id) = self
            .replayed_submission_ids
            .iter()
            .find(|id| !retained_ids.contains(id))
        {
            return Err(format!("replay epoch references absent submission {id}"));
        }
        Ok(())
    }

    pub(super) fn replayed_ids(&self) -> &HashSet<u64> {
        &self.replayed_submission_ids
    }

    pub(super) fn rollback_height(&self) -> Option<u64> {
        self.rollback_height
    }

    pub(super) fn begin(&mut self, height: u64) -> bool {
        if self.rollback_height == Some(height) {
            return false;
        }
        self.rollback_height = Some(height);
        self.replayed_submission_ids.clear();
        true
    }

    pub(super) fn finish_if_advanced(&mut self, height: u64) {
        if matches!(self.rollback_height, Some(rollback) if height > rollback) {
            self.rollback_height = None;
            self.replayed_submission_ids.clear();
        }
    }

    pub(super) fn mark_replayed(&mut self, id: u64) -> bool {
        self.replayed_submission_ids.insert(id)
    }

    pub(super) fn remove(&mut self, id: u64) {
        self.replayed_submission_ids.remove(&id);
    }

    pub(super) fn retain(&mut self, mut keep: impl FnMut(u64) -> bool) {
        self.replayed_submission_ids.retain(|id| keep(*id));
    }

    pub(super) fn clear(&mut self) {
        self.rollback_height = None;
        self.replayed_submission_ids.clear();
    }

    #[cfg(test)]
    pub(super) fn test_insert_replayed(&mut self, id: u64) {
        self.replayed_submission_ids.insert(id);
    }
}
