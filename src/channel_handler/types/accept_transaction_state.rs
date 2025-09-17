use crate::referee::types::RefereeOnChainTransaction;

use serde::{Serialize, Deserialize};

#[derive(Debug, Serialize, Deserialize)]
pub enum AcceptTransactionState {
    Determined(Box<RefereeOnChainTransaction>),
    Waiting,
    Finished,
}
