use crate::referee::types::RefereeOnChainTransaction;

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub enum AcceptTransactionState {
    Determined(Box<RefereeOnChainTransaction>),
    Waiting,
    Finished,
}
