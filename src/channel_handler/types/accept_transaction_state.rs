use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub enum AcceptTransactionState {
    Waiting,
    Finished,
}
