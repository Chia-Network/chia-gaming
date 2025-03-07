use crate::referee::RefereeOnChainTransaction;

#[derive(Debug)]
pub enum AcceptTransactionState {
    Determined(Box<RefereeOnChainTransaction>),
    Waiting,
    Finished,
}
