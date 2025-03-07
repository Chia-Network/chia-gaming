use crate::referee::types::RefereeOnChainTransaction;

#[derive(Debug)]
pub enum AcceptTransactionState {
    Determined(Box<RefereeOnChainTransaction>),
    Waiting,
    Finished,
}
