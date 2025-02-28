use clvm_traits::ToClvmError;

use clvmr::reduction::EvalErr;
use std::io;

/// Error type
#[derive(Debug)]
pub enum Error {
    ClvmErr(EvalErr),
    IoErr(io::Error),
    BasicErr,
    EncodeErr(ToClvmError),
    StrErr(String),
    BlsErr(chia_bls::Error),
    BsonErr(bson::de::Error),
    JsonErr(serde_json::Error),
    HexErr(hex::FromHexError),
    Channel(String),
    GameMoveRejected(Vec<u8>),
}
