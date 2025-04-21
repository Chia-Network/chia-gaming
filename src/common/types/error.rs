use clvm_traits::ToClvmError;
use clvmr::reduction::EvalErr;
use serde::{Deserialize, Serialize, Serializer};
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

#[derive(Serialize, Deserialize)]
struct SerializedError {
    error: String,
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        SerializedError {
            error: format!("{self:?}"),
        }
        .serialize(serializer)
    }
}

pub trait ErrToError {
    fn into_gen(self) -> Error;
}

impl ErrToError for EvalErr {
    fn into_gen(self) -> Error {
        Error::ClvmErr(self)
    }
}

impl ErrToError for io::Error {
    fn into_gen(self) -> Error {
        Error::IoErr(self)
    }
}

impl ErrToError for String {
    fn into_gen(self) -> Error {
        Error::StrErr(self)
    }
}

impl ErrToError for chia_bls::Error {
    fn into_gen(self) -> Error {
        Error::BlsErr(self)
    }
}

impl ErrToError for ToClvmError {
    fn into_gen(self) -> Error {
        Error::EncodeErr(self)
    }
}

impl ErrToError for bson::de::Error {
    fn into_gen(self) -> Error {
        Error::BsonErr(self)
    }
}

impl ErrToError for serde_json::Error {
    fn into_gen(self) -> Error {
        Error::JsonErr(self)
    }
}

impl ErrToError for hex::FromHexError {
    fn into_gen(self) -> Error {
        Error::HexErr(self)
    }
}

pub trait IntoErr<X> {
    fn into_gen(self) -> Result<X, Error>;
}

impl<X, E> IntoErr<X> for Result<X, E>
where
    E: ErrToError,
{
    fn into_gen(self) -> Result<X, Error> {
        self.map_err(|e| e.into_gen())
    }
}
