use std::borrow::Borrow;
use std::io;
use std::ops::{Add, AddAssign, Sub, SubAssign};
use std::rc::Rc;

use log::debug;

use serde::de::Visitor;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use num_bigint::{BigInt, Sign, ToBigInt};
use num_traits::cast::ToPrimitive;

use rand::distributions::Standard;
use rand::prelude::*;

use sha2::{Digest, Sha256};

use clvmr::allocator::{Allocator, NodePtr, SExp};
use clvmr::reduction::EvalErr;
use clvmr::serde::{node_from_bytes, node_to_bytes};
use clvmr::{run_program, ChiaDialect, NO_UNKNOWN_OPS};

use clvm_tools_rs::classic::clvm::sexp::proper_list;
use clvm_tools_rs::classic::clvm::syntax_error::SyntaxErr;
use clvm_tools_rs::classic::clvm_tools::binutils::disassemble;
use clvm_tools_rs::classic::clvm_tools::sha256tree::sha256tree;

use crate::common::constants::{AGG_SIG_ME_ATOM, AGG_SIG_UNSAFE_ATOM, CREATE_COIN_ATOM, REM_ATOM};

use chia_bls;
use chia_bls::signature::{sign, verify};
use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};

#[cfg(test)]
use clvm_tools_rs::compiler::runtypes::RunFailure;

pub fn chia_dialect() -> ChiaDialect {
    ChiaDialect::new(NO_UNKNOWN_OPS)
}

/// CoinID
#[derive(Default, Clone, Debug, Serialize, Deserialize, Eq, PartialEq, Hash)]
pub struct CoinID(Hash);

impl CoinID {
    pub fn new(h: Hash) -> CoinID {
        CoinID(h)
    }
    pub fn bytes(&self) -> &[u8] {
        self.0.bytes()
    }
}

impl ToClvm<NodePtr> for CoinID {
    fn to_clvm(
        &self,
        encoder: &mut impl ClvmEncoder<Node = NodePtr>,
    ) -> Result<NodePtr, ToClvmError> {
        self.0.to_clvm(encoder)
    }
}

/// Coin String
#[derive(Default, Clone, Serialize, Deserialize, Eq, PartialEq, Hash)]
pub struct CoinString(Vec<u8>);

impl std::fmt::Debug for CoinString {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        writeln!(formatter, "{:?}", self.to_parts())
    }
}

impl CoinString {
    pub fn from_bytes(bytes: &[u8]) -> CoinString {
        CoinString(bytes.to_vec())
    }

    pub fn to_bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn from_parts(parent: &CoinID, puzzle_hash: &PuzzleHash, amount: &Amount) -> CoinString {
        let mut allocator = AllocEncoder::new();
        let amount_clvm = amount.to_clvm(&mut allocator).unwrap();
        let mut res = Vec::new();
        res.append(&mut parent.bytes().to_vec());
        res.append(&mut puzzle_hash.bytes().to_vec());
        res.append(&mut allocator.allocator().atom(amount_clvm).to_vec());
        CoinString(res)
    }

    pub fn to_parts(&self) -> Option<(CoinID, PuzzleHash, Amount)> {
        if self.0.len() < 64 {
            return None;
        }

        let parent_id = CoinID::new(Hash::from_slice(&self.0[..32]));
        let puzzle_hash = PuzzleHash::from_hash(Hash::from_slice(&self.0[32..64]));
        let amount_bytes = &self.0[64..];
        BigInt::from_bytes_be(Sign::Plus, amount_bytes)
            .to_u64()
            .map(|a| (parent_id, puzzle_hash, Amount::new(a)))
    }

    pub fn to_coin_id(&self) -> CoinID {
        CoinID(Hash::new(&self.0))
    }
}

/// Private Key
#[derive(Clone, Debug)]
pub struct PrivateKey(chia_bls::SecretKey);

impl Default for PrivateKey {
    fn default() -> Self {
        PrivateKey(chia_bls::SecretKey::from_seed(&[0; 32]))
    }
}

impl AddAssign for PrivateKey {
    fn add_assign(&mut self, rhs: Self) {
        self.0 += &rhs.0;
    }
}

impl Add for PrivateKey {
    type Output = PrivateKey;

    fn add(mut self, rhs: Self) -> PrivateKey {
        self += rhs;
        self
    }
}

impl PrivateKey {
    pub fn from_bls(sk: chia_bls::SecretKey) -> PrivateKey {
        PrivateKey(sk)
    }

    pub fn from_bytes(by: &[u8; 32]) -> Result<PrivateKey, Error> {
        Ok(PrivateKey::from_bls(
            chia_bls::SecretKey::from_bytes(by).into_gen()?,
        ))
    }

    pub fn to_bls(&self) -> &chia_bls::SecretKey {
        &self.0
    }

    pub fn sign<Msg: AsRef<[u8]>>(&self, msg: Msg) -> Aggsig {
        Aggsig(sign(&self.0, msg))
    }

    pub fn bytes(&self) -> [u8; 32] {
        self.0.to_bytes()
    }
}

impl Distribution<Hash> for Standard {
    fn sample<R: Rng + ?Sized>(&self, rng: &mut R) -> Hash {
        let mut pk = [0; 32];
        for item in &mut pk {
            *item = rng.gen();
        }
        Hash::from_bytes(pk)
    }
}

impl Distribution<PrivateKey> for Standard {
    fn sample<R: Rng + ?Sized>(&self, rng: &mut R) -> PrivateKey {
        let hash: Hash = rng.gen();
        PrivateKey(chia_bls::SecretKey::from_seed(hash.bytes()))
    }
}

struct SerdeByteConsumer;

impl Visitor<'_> for SerdeByteConsumer {
    type Value = Vec<u8>;
    fn expecting(&self, fmt: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        fmt.write_str("expected bytes")
    }
    fn visit_bytes<E>(self, v: &[u8]) -> Result<Self::Value, E> {
        Ok(v.to_vec())
    }
}

/// Public key
#[derive(Clone, Eq, PartialEq, Debug, Default)]
pub struct PublicKey(chia_bls::PublicKey);

impl Serialize for PublicKey {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let bytes = self.bytes();
        serializer.serialize_bytes(&bytes)
    }
}

impl<'de> Deserialize<'de> for PublicKey {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let b = SerdeByteConsumer;
        let bytes = deserializer.deserialize_bytes(b);
        let mut fixed_bytes: [u8; 48] = [0; 48];
        for v in bytes.into_iter().take(1) {
            for (i, b) in v.into_iter().enumerate() {
                fixed_bytes[i] = b;
            }
        }
        PublicKey::from_bytes(fixed_bytes)
            .map_err(|e| serde::de::Error::custom(format!("couldn't make pubkey: {e:?}")))
    }
}

impl PublicKey {
    pub fn to_bls(&self) -> chia_bls::PublicKey {
        self.0
    }

    pub fn bytes(&self) -> [u8; 48] {
        self.0.to_bytes()
    }

    pub fn from_bytes(bytes: [u8; 48]) -> Result<PublicKey, Error> {
        Ok(PublicKey(
            chia_bls::PublicKey::from_bytes(&bytes).into_gen()?,
        ))
    }

    pub fn from_bls(pk: chia_bls::PublicKey) -> PublicKey {
        PublicKey(pk)
    }
}

impl AddAssign for PublicKey {
    fn add_assign(&mut self, rhs: Self) {
        self.0 += &rhs.0;
    }
}

impl Add for PublicKey {
    type Output = PublicKey;

    fn add(mut self, rhs: Self) -> PublicKey {
        self += rhs;
        self
    }
}

impl ToClvm<NodePtr> for PublicKey {
    fn to_clvm(
        &self,
        encoder: &mut impl ClvmEncoder<Node = NodePtr>,
    ) -> Result<NodePtr, ToClvmError> {
        encoder.encode_atom(&self.0.to_bytes())
    }
}

/// Aggsig
#[derive(Clone, Eq, PartialEq, Debug, Default)]
pub struct Aggsig(chia_bls::Signature);

impl Serialize for Aggsig {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let bytes = self.bytes();
        serializer.serialize_bytes(&bytes)
    }
}

impl<'de> Deserialize<'de> for Aggsig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let b = SerdeByteConsumer;
        let bytes = deserializer.deserialize_bytes(b);
        let mut fixed_bytes: [u8; 96] = [0; 96];
        for v in bytes.into_iter().take(1) {
            for (i, b) in v.into_iter().enumerate() {
                fixed_bytes[i] = b;
            }
        }
        Aggsig::from_bytes(fixed_bytes)
            .map_err(|e| serde::de::Error::custom(format!("couldn't make aggsig: {e:?}")))
    }
}

impl Aggsig {
    pub fn from_bls(bls: chia_bls::Signature) -> Aggsig {
        Aggsig(bls)
    }

    pub fn from_bytes(by: [u8; 96]) -> Result<Aggsig, Error> {
        Ok(Aggsig(chia_bls::Signature::from_bytes(&by).into_gen()?))
    }

    pub fn from_slice(by: &[u8]) -> Result<Aggsig, Error> {
        if by.len() != 96 {
            return Err(Error::StrErr("bad aggsig length".to_string()));
        }
        let mut fixed: [u8; 96] = [0; 96];
        for (i, b) in by.iter().enumerate() {
            fixed[i % 96] = *b;
        }
        Aggsig::from_bytes(fixed)
    }

    pub fn bytes(&self) -> [u8; 96] {
        self.0.to_bytes()
    }

    pub fn to_bls(&self) -> chia_bls::Signature {
        self.0.clone()
    }

    pub fn verify(&self, public_key: &PublicKey, msg: &[u8]) -> bool {
        verify(&self.0, &public_key.to_bls(), msg)
    }

    pub fn aggregate(&self, other: &Aggsig) -> Aggsig {
        let mut result = self.0.clone();
        result.aggregate(&other.0);
        Aggsig(result)
    }

    pub fn scalar_multiply(&mut self, int_bytes: &[u8]) {
        self.0.scalar_multiply(int_bytes)
    }
}

impl AddAssign for Aggsig {
    fn add_assign(&mut self, rhs: Self) {
        self.0 += &rhs.0;
    }
}

impl Add for Aggsig {
    type Output = Aggsig;

    fn add(mut self, rhs: Self) -> Aggsig {
        self += rhs;
        self
    }
}

impl ToClvm<NodePtr> for Aggsig {
    fn to_clvm(
        &self,
        encoder: &mut impl ClvmEncoder<Node = NodePtr>,
    ) -> Result<NodePtr, ToClvmError> {
        encoder.encode_atom(&self.0.to_bytes())
    }
}

/// Game ID
#[derive(Default, Clone, Debug, Eq, PartialEq, Serialize, Deserialize, Hash)]
pub struct GameID(Vec<u8>);

impl GameID {
    pub fn new(s: Vec<u8>) -> GameID {
        GameID(s)
    }

    pub fn from_clvm(allocator: &mut AllocEncoder, clvm: NodePtr) -> Result<Self, Error> {
        if let Some(atom) = atom_from_clvm(allocator, clvm) {
            Ok(GameID::new(atom.to_vec()))
        } else {
            Err(Error::StrErr("bad game id".to_string()))
        }
    }
}

impl GameID {
    pub fn from_bytes(s: &[u8]) -> GameID {
        GameID(s.to_vec())
    }

    pub fn to_bytes(&self) -> &[u8] {
        &self.0
    }
}

impl ToClvm<NodePtr> for GameID {
    fn to_clvm(
        &self,
        encoder: &mut impl ClvmEncoder<Node = NodePtr>,
    ) -> Result<NodePtr, ToClvmError> {
        encoder.encode_atom(&self.0)
    }
}

/// Amount
#[derive(Default, Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
pub struct Amount(u64);

impl Amount {
    pub fn new(amt: u64) -> Amount {
        Amount(amt)
    }

    pub fn half(&self) -> Amount {
        Amount::new(self.0 / 2)
    }

    pub fn to_u64(&self) -> u64 {
        self.0
    }

    pub fn from_clvm(allocator: &mut AllocEncoder, clvm: NodePtr) -> Result<Amount, Error> {
        if let Some(val) = atom_from_clvm(allocator, clvm).and_then(u64_from_atom) {
            Ok(Amount::new(val))
        } else {
            Err(Error::StrErr("bad amount".to_string()))
        }
    }
}

impl AddAssign for Amount {
    fn add_assign(&mut self, rhs: Self) {
        self.0 += rhs.0;
    }
}

impl Add for Amount {
    type Output = Amount;

    fn add(mut self, rhs: Self) -> Amount {
        self += rhs;
        self
    }
}

impl SubAssign for Amount {
    fn sub_assign(&mut self, rhs: Self) {
        self.0 -= rhs.0;
    }
}

impl Sub for Amount {
    type Output = Amount;

    fn sub(mut self, rhs: Self) -> Amount {
        self -= rhs;
        self
    }
}

impl ToClvm<NodePtr> for Amount {
    fn to_clvm(
        &self,
        encoder: &mut impl ClvmEncoder<Node = NodePtr>,
    ) -> Result<NodePtr, ToClvmError> {
        self.0.to_clvm(encoder)
    }
}

impl From<Amount> for u64 {
    fn from(amt: Amount) -> Self {
        amt.0
    }
}

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize, Hash, Default)]
pub struct Hash([u8; 32]);

impl ToClvm<NodePtr> for Hash {
    fn to_clvm(
        &self,
        encoder: &mut impl ClvmEncoder<Node = NodePtr>,
    ) -> Result<NodePtr, ToClvmError> {
        encoder.encode_atom(&self.0)
    }
}

impl std::fmt::Debug for Hash {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        write!(formatter, "Hash(")?;
        write!(formatter, "{}", hex::encode(self.0))?;
        write!(formatter, ")")
    }
}

impl Hash {
    pub fn new(by: &[u8]) -> Hash {
        Sha256Input::Bytes(by).hash()
    }
    pub fn from_bytes(by: [u8; 32]) -> Hash {
        Hash(by)
    }
    pub fn from_slice(by: &[u8]) -> Hash {
        let mut fixed: [u8; 32] = [0; 32];
        for (i, b) in by.iter().enumerate().take(32) {
            fixed[i % 32] = *b;
        }
        Hash::from_bytes(fixed)
    }
    pub fn bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

#[derive(Debug)]
pub enum Sha256Input<'a> {
    Bytes(&'a [u8]),
    Hashed(Vec<Sha256Input<'a>>),
    Hash(&'a Hash),
    Array(Vec<Sha256Input<'a>>),
}

impl Sha256Input<'_> {
    fn update(&self, hasher: &mut Sha256) {
        match self {
            Sha256Input::Bytes(b) => {
                hasher.update(b);
            }
            Sha256Input::Hash(hash) => {
                hasher.update(hash.bytes());
            }
            Sha256Input::Hashed(input) => {
                let mut new_hasher = Sha256::new();
                for i in input.iter() {
                    i.update(&mut new_hasher);
                }
                let result = new_hasher.finalize();
                hasher.update(&result[..]);
            }
            Sha256Input::Array(inputs) => {
                for i in inputs.iter() {
                    i.update(hasher);
                }
            }
        }
    }

    pub fn hash(&self) -> Hash {
        let mut hasher = Sha256::new();
        self.update(&mut hasher);
        let result = hasher.finalize();
        Hash::from_slice(&result[..])
    }
}

/// Puzzle hash
#[derive(Default, Clone, Eq, PartialEq, Debug, Serialize, Deserialize, Hash)]
pub struct PuzzleHash(Hash);

impl PuzzleHash {
    pub fn from_bytes(by: [u8; 32]) -> PuzzleHash {
        PuzzleHash(Hash::from_bytes(by))
    }
    pub fn from_hash(h: Hash) -> PuzzleHash {
        PuzzleHash(h)
    }
    pub fn bytes(&self) -> &[u8] {
        self.0.bytes()
    }
    pub fn hash(&self) -> &Hash {
        &self.0
    }
}

impl Distribution<PuzzleHash> for Standard {
    fn sample<R: Rng + ?Sized>(&self, rng: &mut R) -> PuzzleHash {
        PuzzleHash::from_hash(rng.gen())
    }
}

impl ToClvm<NodePtr> for PuzzleHash {
    fn to_clvm(
        &self,
        encoder: &mut impl ClvmEncoder<Node = NodePtr>,
    ) -> Result<NodePtr, ToClvmError> {
        encoder.encode_atom(&self.0 .0)
    }
}

/// Error type
#[derive(Debug)]
pub enum Error {
    ClvmErr(EvalErr),
    IoErr(io::Error),
    BasicErr,
    SyntaxErr(SyntaxErr),
    EncodeErr(ToClvmError),
    StrErr(String),
    BlsErr(chia_bls::Error),
    BsonErr(bson::de::Error),
    JsonErr(serde_json::Error),
    HexErr(hex::FromHexError),
    Channel(String),
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

#[derive(Clone, Debug)]
pub struct Node(pub NodePtr);

impl Default for Node {
    fn default() -> Node {
        let allocator = Allocator::new();
        Node(allocator.null())
    }
}

impl Node {
    #[cfg(any(test, feature = "sim-tests", feature = "simulator"))]
    pub fn to_hex(&self, allocator: &mut AllocEncoder) -> Result<String, Error> {
        let bytes = node_to_bytes(allocator.allocator(), self.0).into_gen()?;
        Ok(hex::encode(bytes))
    }
}

impl ToClvm<NodePtr> for Node {
    fn to_clvm(
        &self,
        _encoder: &mut impl ClvmEncoder<Node = NodePtr>,
    ) -> Result<NodePtr, ToClvmError> {
        Ok(self.0)
    }
}

pub trait ToQuotedProgram {
    fn to_quoted_program(&self, allocator: &mut AllocEncoder) -> Result<Program, Error>;
}

impl ToQuotedProgram for NodePtr {
    fn to_quoted_program(&self, allocator: &mut AllocEncoder) -> Result<Program, Error> {
        let pair = allocator.0.new_pair(allocator.0.one(), *self).into_gen()?;
        Program::from_nodeptr(allocator, pair)
    }
}

pub trait Sha256tree {
    fn sha256tree(&self, allocator: &mut AllocEncoder) -> PuzzleHash;
}

impl<X: ToClvm<NodePtr>> Sha256tree for X {
    fn sha256tree(&self, allocator: &mut AllocEncoder) -> PuzzleHash {
        let node = self
            .to_clvm(allocator)
            .unwrap_or_else(|_| allocator.0.null());
        let mut fixed: [u8; 32] = [0; 32];
        for (i, b) in sha256tree(allocator.allocator(), node)
            .data()
            .iter()
            .enumerate()
        {
            fixed[i % 32] = *b;
        }
        PuzzleHash::from_bytes(fixed)
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Program(pub Vec<u8>);

impl std::fmt::Debug for Program {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        write!(f, "Program({})", hex::encode(&self.0))
    }
}

impl Program {
    pub fn to_nodeptr(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        clvmr::serde::node_from_bytes(allocator.allocator(), &self.0).into_gen()
    }
    pub fn from_nodeptr(allocator: &mut AllocEncoder, n: NodePtr) -> Result<Program, Error> {
        let bytes = clvmr::serde::node_to_bytes(allocator.allocator(), n).into_gen()?;
        Ok(Program(bytes))
    }

    pub fn from_hex(s: &str) -> Result<Program, Error> {
        let bytes = hex::decode(s).into_gen()?;
        Ok(Program::from_bytes(&bytes))
    }

    pub fn from_bytes(by: &[u8]) -> Program {
        Program(by.to_vec())
    }

    pub fn bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        hex::encode(&self.0)
    }
}

fn clone_to_encoder(
    encoder: &mut impl ClvmEncoder<Node = NodePtr>,
    source_allocator: &Allocator,
    node: NodePtr,
) -> Result<NodePtr, ToClvmError> {
    match source_allocator.sexp(node) {
        SExp::Atom => {
            let buf = source_allocator.atom(node);
            encoder.encode_atom(buf)
        }
        SExp::Pair(a, b) => {
            let ac = clone_to_encoder(encoder, source_allocator, a)?;
            let bc = clone_to_encoder(encoder, source_allocator, b)?;
            encoder.encode_pair(ac, bc)
        }
    }
}

impl ToClvm<NodePtr> for Program {
    fn to_clvm(
        &self,
        encoder: &mut impl ClvmEncoder<Node = NodePtr>,
    ) -> Result<NodePtr, ToClvmError> {
        let mut allocator = Allocator::new();
        let result = node_from_bytes(&mut allocator, &self.0)
            .map_err(|e| ToClvmError::Custom(format!("{e:?}")))?;
        clone_to_encoder(encoder, &allocator, result)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Puzzle(Rc<Program>);

impl ToClvm<NodePtr> for Puzzle {
    fn to_clvm(
        &self,
        encoder: &mut impl ClvmEncoder<Node = NodePtr>,
    ) -> Result<NodePtr, ToClvmError> {
        self.0.to_clvm(encoder)
    }
}

impl Puzzle {
    pub fn to_program(&self) -> Rc<Program> {
        self.0.clone()
    }
    pub fn from_bytes(by: &[u8]) -> Puzzle {
        Puzzle(Rc::new(Program::from_bytes(by)))
    }
    pub fn from_nodeptr(allocator: &mut AllocEncoder, node: NodePtr) -> Result<Puzzle, Error> {
        let bytes = node_to_bytes(allocator.allocator(), node).into_gen()?;
        Ok(Puzzle::from_bytes(&bytes))
    }
    pub fn to_hex(&self) -> String {
        self.0.to_hex()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct Timeout(u64);

impl Timeout {
    pub fn new(t: u64) -> Self {
        Timeout(t)
    }

    pub fn to_u64(&self) -> u64 {
        self.0
    }

    pub fn from_clvm(allocator: &mut AllocEncoder, clvm: NodePtr) -> Result<Self, Error> {
        if let Some(amt) = atom_from_clvm(allocator, clvm).and_then(u64_from_atom) {
            Ok(Timeout::new(amt))
        } else {
            Err(Error::StrErr("bad timeout".to_string()))
        }
    }
}

impl Add for Timeout {
    type Output = Timeout;

    fn add(self, rhs: Self) -> Timeout {
        Timeout::new(self.0 + rhs.0)
    }
}

impl ToClvm<NodePtr> for Timeout {
    fn to_clvm(
        &self,
        encoder: &mut impl ClvmEncoder<Node = NodePtr>,
    ) -> Result<NodePtr, ToClvmError> {
        self.0.to_clvm(encoder)
    }
}

pub struct AllocEncoder(Allocator);

impl Default for AllocEncoder {
    fn default() -> Self {
        AllocEncoder(Allocator::new())
    }
}

impl AllocEncoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn allocator(&mut self) -> &mut Allocator {
        &mut self.0
    }
}

impl ClvmEncoder for AllocEncoder {
    type Node = NodePtr;

    fn encode_atom(&mut self, bytes: &[u8]) -> Result<Self::Node, ToClvmError> {
        self.0
            .new_atom(bytes)
            .map_err(|e| ToClvmError::Custom(format!("{e:?}")))
    }

    fn encode_pair(
        &mut self,
        first: Self::Node,
        rest: Self::Node,
    ) -> Result<Self::Node, ToClvmError> {
        self.0
            .new_pair(first, rest)
            .map_err(|e| ToClvmError::Custom(format!("{e:?}")))
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

#[cfg(test)]
impl ErrToError for RunFailure {
    fn into_gen(self) -> Error {
        Error::StrErr(format!("{self:?}"))
    }
}

impl ErrToError for SyntaxErr {
    fn into_gen(self) -> Error {
        Error::SyntaxErr(self)
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

#[derive(Debug, Clone)]
pub enum CoinCondition {
    AggSigMe(PublicKey, Vec<u8>),
    AggSigUnsafe(PublicKey, Vec<u8>),
    #[allow(dead_code)]
    CreateCoin(PuzzleHash, Amount),
    Rem(Vec<Vec<u8>>),
}

fn parse_condition(allocator: &mut AllocEncoder, condition: NodePtr) -> Option<CoinCondition> {
    let exploded = proper_list(allocator.allocator(), condition, true)?;
    let public_key_from_bytes = |b: &[u8]| -> Result<PublicKey, Error> {
        let mut fixed: [u8; 48] = [0; 48];
        for (i, b) in b.iter().enumerate() {
            fixed[i % 48] = *b;
        }
        PublicKey::from_bytes(fixed)
    };
    if exploded.len() > 2
        && matches!(
            (
                allocator.allocator().sexp(exploded[0]),
                allocator.allocator().sexp(exploded[1]),
                allocator.allocator().sexp(exploded[2])
            ),
            (SExp::Atom, SExp::Atom, SExp::Atom)
        )
    {
        let atoms: Vec<Vec<u8>> = exploded
            .iter()
            .take(3)
            .map(|a| allocator.allocator().atom(*a).to_vec())
            .collect();
        if *atoms[0] == AGG_SIG_UNSAFE_ATOM {
            if let Ok(pk) = public_key_from_bytes(&atoms[1]) {
                return Some(CoinCondition::AggSigUnsafe(pk, atoms[2].to_vec()));
            }
        } else if *atoms[0] == AGG_SIG_ME_ATOM {
            if let Ok(pk) = public_key_from_bytes(&atoms[1]) {
                return Some(CoinCondition::AggSigMe(pk, atoms[2].to_vec()));
            }
        } else if *atoms[0] == CREATE_COIN_ATOM {
            if let Some(amt) = u64_from_atom(&atoms[2]) {
                return Some(CoinCondition::CreateCoin(
                    PuzzleHash::from_hash(Hash::from_slice(&atoms[1])),
                    Amount::new(amt),
                ));
            }
        }
    }

    if !exploded.is_empty()
        && exploded
            .iter()
            .all(|e| matches!(allocator.allocator().sexp(*e), SExp::Atom))
    {
        let atoms: Vec<Vec<u8>> = exploded
            .iter()
            .map(|a| allocator.allocator().atom(*a).to_vec())
            .collect();
        if *atoms[0] == REM_ATOM {
            return Some(CoinCondition::Rem(
                atoms.iter().skip(1).map(|a| a.to_vec()).collect(),
            ));
        }
    }

    None
}

impl CoinCondition {
    pub fn from_nodeptr(allocator: &mut AllocEncoder, conditions: NodePtr) -> Vec<CoinCondition> {
        // Ensure this borrow of allocator is finished for what's next.
        if let Some(exploded) = proper_list(allocator.allocator(), conditions, true) {
            exploded
                .iter()
                .flat_map(|cond| parse_condition(allocator, *cond))
                .collect()
        } else {
            Vec::new()
        }
    }

    pub fn from_puzzle_and_solution(
        allocator: &mut AllocEncoder,
        puzzle: &Program,
        solution: &Program,
    ) -> Result<Vec<CoinCondition>, Error> {
        let run_puzzle = puzzle.to_nodeptr(allocator)?;
        let run_args = solution.to_nodeptr(allocator)?;
        let conditions = run_program(
            allocator.allocator(),
            &chia_dialect(),
            run_puzzle,
            run_args,
            0,
        )
        .into_gen()?;
        debug!(
            "conditions to parse {}",
            disassemble(allocator.allocator(), conditions.1, None)
        );

        Ok(CoinCondition::from_nodeptr(allocator, conditions.1))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Spend {
    pub puzzle: Rc<Puzzle>,
    pub solution: Rc<Program>,
    pub signature: Aggsig,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CoinSpend {
    pub coin: CoinString,
    pub bundle: Spend,
}

impl Default for Spend {
    fn default() -> Self {
        Spend {
            puzzle: Rc::new(Puzzle::from_bytes(&[0x80])),
            solution: Rc::new(Program::from_bytes(&[0x80])),
            signature: Aggsig::default(),
        }
    }
}

pub struct SpendRewardResult {
    pub coins_with_solutions: Vec<CoinSpend>,
    pub result_coin_string_up: CoinString,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpendBundle {
    pub name: Option<String>,
    pub spends: Vec<CoinSpend>,
}

pub fn usize_from_atom(a: &[u8]) -> Option<usize> {
    let bi = BigInt::from_bytes_be(Sign::Plus, a);
    bi.to_usize()
}

pub fn i32_from_atom(a: &[u8]) -> Option<i32> {
    let bi = BigInt::from_signed_bytes_be(a);
    bi.to_i32()
}

pub fn i64_from_atom(a: &[u8]) -> Option<i64> {
    let bi = BigInt::from_signed_bytes_be(a);
    bi.to_i64()
}

pub fn u64_from_atom(a: &[u8]) -> Option<u64> {
    let bi = BigInt::from_bytes_be(Sign::Plus, a);
    bi.to_u64()
}

pub fn atom_from_clvm(allocator: &mut AllocEncoder, n: NodePtr) -> Option<&[u8]> {
    if matches!(allocator.allocator().sexp(n), SExp::Atom) {
        Some(allocator.allocator().atom(n))
    } else {
        None
    }
}

/// Maximum information about a coin spend.  Everything one might need downstream.
pub struct BrokenOutCoinSpendInfo {
    pub solution: Rc<Program>,
    pub conditions: Rc<Program>,
    pub message: Vec<u8>,
    pub signature: Aggsig,
}

pub fn divmod(a: BigInt, b: BigInt) -> (BigInt, BigInt) {
    let d = a.clone() / b.clone();
    let r = a.clone() % b.clone();
    let zero = 0.to_bigint().unwrap();
    if d < zero && r != zero {
        (d - 1.to_bigint().unwrap(), r + b)
    } else {
        (d, r)
    }
}

#[test]
fn test_local_divmod() {
    assert_eq!(
        divmod((-7).to_bigint().unwrap(), 2.to_bigint().unwrap()),
        ((-4).to_bigint().unwrap(), 1.to_bigint().unwrap())
    );
    assert_eq!(
        divmod(7.to_bigint().unwrap(), (-2).to_bigint().unwrap()),
        ((-4).to_bigint().unwrap(), (-1).to_bigint().unwrap())
    );
    assert_eq!(
        divmod((-7).to_bigint().unwrap(), (-2).to_bigint().unwrap()),
        (3.to_bigint().unwrap(), (-1).to_bigint().unwrap())
    );
    assert_eq!(
        divmod(7.to_bigint().unwrap(), 2.to_bigint().unwrap()),
        (3.to_bigint().unwrap(), 1.to_bigint().unwrap())
    );
}

pub struct RcNode<X>(Rc<X>);

impl<X: ToClvm<NodePtr>> ToClvm<NodePtr> for RcNode<X> {
    fn to_clvm(
        &self,
        encoder: &mut impl ClvmEncoder<Node = NodePtr>,
    ) -> Result<NodePtr, ToClvmError> {
        let borrowed: &X = self.0.borrow();
        borrowed.to_clvm(encoder)
    }
}

impl<X> RcNode<X> {
    pub fn new(node: Rc<X>) -> Self {
        RcNode(node.clone())
    }
}

impl<X> From<&Rc<X>> for RcNode<X> {
    fn from(item: &Rc<X>) -> RcNode<X> {
        RcNode(item.clone())
    }
}
