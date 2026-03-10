use crate::common::types::Spend;

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub enum AcceptTransactionState {
    Determined(Box<Spend>),
    Waiting,
    Finished,
}
