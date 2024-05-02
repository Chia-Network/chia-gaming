use std::io;
use std::ops::{Add, AddAssign};

use num_bigint::BigInt;

use rand::prelude::*;
use rand::distributions::Standard;

use clvmr::allocator::{Allocator, NodePtr};
use clvmr::reduction::EvalErr;

use clvm_tools_rs::classic::clvm::__type_compatibility__::{Bytes, BytesFromType, sha256};
use clvm_tools_rs::classic::clvm_tools::sha256tree;
use clvm_tools_rs::classic::clvm::syntax_error::SyntaxErr;

use clvm_traits::{ToClvm, ClvmEncoder, ToClvmError};
use chia_bls;
use chia_bls::signature::{sign, verify};

/// CoinID
#[derive(Default, Clone)]
pub struct CoinID(Hash);

impl CoinID {
    pub fn bytes<'a>(&'a self) -> &'a [u8] {
        self.0.bytes()
    }
}

impl ToClvm<NodePtr> for CoinID {
    fn to_clvm(&self, encoder: &mut impl ClvmEncoder<Node = NodePtr>) -> Result<NodePtr, ToClvmError> {
        self.0.to_clvm(encoder)
    }
}

/// Coin String
#[derive(Default, Clone)]
pub struct CoinString(Vec<u8>);

impl CoinString {
    pub fn from_parts(parent: &CoinID, puzzle_hash: &PuzzleHash, amount: &Amount) -> CoinString {
        let mut allocator = Allocator::new();
        let amount_clvm = amount.to_clvm(&mut AllocEncoder(&mut allocator)).unwrap();
        let mut res = Vec::new();
        res.append(&mut parent.bytes().to_vec());
        res.append(&mut puzzle_hash.bytes().to_vec());
        res.append(&mut allocator.atom(amount_clvm).to_vec());
        CoinString(res)
    }

    pub fn to_coin_id(&self) -> CoinID {
        CoinID(Hash::new(&self.0))
    }
}

/// Private Key
#[derive(Clone)]
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

    pub fn to_bls(&self) -> &chia_bls::SecretKey {
        &self.0
    }

    pub fn sign<Msg: AsRef<[u8]>>(&self, msg: Msg) -> Aggsig {
        Aggsig(sign(&self.0, msg))
    }

    pub fn bytes(&self) -> [u8; 32] {
        self.0.to_bytes()
    }

    pub fn scalar_multiply(scalar: &BigInt) -> PrivateKey {
        // start with result = the "Point at infinity" and bit_val = self.
        // For each bit in scalar, add bit_val to result if 1 and double bit_val
        // by addition.
        todo!();
    }
}

/// Public key
#[derive(Clone, Eq, PartialEq)]
pub struct PublicKey(chia_bls::PublicKey);

impl Default for PublicKey {
    fn default() -> Self {
        PublicKey(chia_bls::PublicKey::default())
    }
}

impl PublicKey {
    pub fn to_bls(&self) -> chia_bls::PublicKey {
        self.0.clone()
    }

    pub fn bytes(&self) -> [u8; 48] {
        self.0.to_bytes()
    }

    pub fn from_bytes(bytes: [u8; 48]) -> Result<PublicKey, Error> {
        Ok(PublicKey(chia_bls::PublicKey::from_bytes(&bytes).into_gen()?))
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
    fn to_clvm(&self, encoder: &mut impl ClvmEncoder<Node = NodePtr>) -> Result<NodePtr, ToClvmError> {
        encoder.encode_atom(&self.0.to_bytes())
    }
}

impl PublicKey {
    pub fn from_bls(pk: chia_bls::PublicKey) -> PublicKey {
        PublicKey(pk)
    }
}

/// Aggsig
#[derive(Clone, Eq, PartialEq, Debug)]
pub struct Aggsig(chia_bls::Signature);

impl Default for Aggsig {
    // Revisit for empty aggsig.
    fn default() -> Self {
        Aggsig(chia_bls::Signature::default())
    }
}

impl Aggsig {
    pub fn from_bls(bls: chia_bls::Signature) -> Aggsig {
        Aggsig(bls)
    }

    pub fn from_bytes(by: [u8; 96]) -> Result<Aggsig, Error> {
        Ok(Aggsig(chia_bls::Signature::from_bytes(&by).into_gen()?))
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

impl Distribution<PrivateKey> for Standard {
    fn sample<R: Rng + ?Sized>(&self, rng: &mut R) -> PrivateKey {
        let mut pk = [0; 32];
        for i in 0..32 {
            pk[i] = rng.gen();
        }
        PrivateKey(chia_bls::SecretKey::from_seed(&pk))
    }
}

/// Game ID
#[derive(Default, Clone)]
pub struct GameID(Vec<u8>);

/// Amount
#[derive(Default, Clone)]
pub struct Amount(u64);

impl Amount {
    pub fn new(amt: u64) -> Amount {
        Amount(amt)
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

impl ToClvm<NodePtr> for Amount {
    fn to_clvm(&self, encoder: &mut impl ClvmEncoder<Node = NodePtr>) -> Result<NodePtr, ToClvmError> {
        self.0.to_clvm(encoder)
    }
}

impl From<Amount> for u64 {
    fn from(amt: Amount) -> Self {
        amt.0
    }
}

#[derive(Clone, Eq, PartialEq, Debug)]
pub struct Hash([u8; 32]);

impl Default for Hash {
    fn default() -> Self {
        Hash([0; 32])
    }
}

impl ToClvm<NodePtr> for Hash {
    fn to_clvm(&self, encoder: &mut impl ClvmEncoder<Node = NodePtr>) -> Result<NodePtr, ToClvmError> {
        encoder.encode_atom(&self.0)
    }
}

impl Hash {
    pub fn new(by: &[u8]) -> Hash {
        let hash_data = sha256(Bytes::new(Some(BytesFromType::Raw(by.to_vec()))));
        let mut fixed: [u8; 32] = [0; 32];
        for (i, b) in hash_data.data().iter().enumerate() {
            fixed[i % 32] = *b;
        }
        Hash(fixed)
    }
    pub fn from_bytes(by: [u8; 32]) -> Hash {
        Hash(by)
    }
    pub fn bytes<'a>(&'a self) -> &'a [u8; 32] {
        &self.0
    }
}

/// Puzzle hash
#[derive(Default, Clone, Eq, PartialEq, Debug)]
pub struct PuzzleHash(Hash);

impl PuzzleHash {
    pub fn from_bytes(by: [u8; 32]) -> PuzzleHash {
        PuzzleHash(Hash::from_bytes(by))
    }
    pub fn bytes<'a>(&'a self) -> &'a [u8] {
        self.0.bytes()
    }
}

impl ToClvm<NodePtr> for PuzzleHash {
    fn to_clvm(&self, encoder: &mut impl ClvmEncoder<Node = NodePtr>) -> Result<NodePtr, ToClvmError> {
        encoder.encode_atom(&self.0.0)
    }
}

/// Referee ID
#[derive(Default, Clone)]
pub struct RefereeID(usize);

/// Error type
#[derive(Debug)]
pub enum Error {
    ClvmError(EvalErr),
    IoError(io::Error),
    BasicError,
    SyntaxErr(SyntaxErr),
    EncodeErr(ToClvmError),
    StrErr(String),
    BlsErr(chia_bls::Error),
    Channel(String)
}

#[derive(Clone)]
pub struct ClvmObject(NodePtr);

impl ToClvm<NodePtr> for ClvmObject {
    fn to_clvm(&self, _encoder: &mut impl ClvmEncoder<Node = NodePtr>) -> Result<NodePtr, ToClvmError> {
        Ok(self.0)
    }
}

impl ClvmObject {
    pub fn nil(allocator: &mut Allocator) -> ClvmObject {
        ClvmObject(allocator.null())
    }

    pub fn from_nodeptr(p: NodePtr) -> ClvmObject {
        ClvmObject(p)
    }
    pub fn to_nodeptr(&self) -> NodePtr {
        self.0
    }
    /// Quote this data so it can be run as code that returns the same data.
    pub fn to_quoted_program(&self, allocator: &mut Allocator) -> Result<Program, Error> {
        let pair = allocator.new_pair(allocator.one(), self.to_nodeptr()).into_gen()?;
        Ok(Program::from_nodeptr(pair))
    }
}

pub trait ToClvmObject {
    fn to_clvm_obj(&self) -> ClvmObject;
    fn to_nodeptr(&self) -> NodePtr {
        self.to_clvm_obj().0
    }
}

pub trait Sha256tree {
    fn sha256tree(&self, allocator: &mut Allocator) -> PuzzleHash;
}

impl Sha256tree for ClvmObject {
    fn sha256tree(&self, allocator: &mut Allocator) -> PuzzleHash {
        let by = sha256tree::sha256tree(allocator, self.0);
        let mut hash_into: [u8; 32] = [0; 32];
        for (i,b) in by.data().iter().take(32).enumerate() {
            hash_into[i] = *b;
        }
        PuzzleHash(Hash(hash_into))
    }
}

impl<X: ToClvmObject> Sha256tree for X {
    fn sha256tree(&self, allocator: &mut Allocator) -> PuzzleHash {
        self.to_clvm_obj().sha256tree(allocator)
    }
}

#[derive(Clone)]
pub struct Program(ClvmObject);

impl Program {
    pub fn from_nodeptr(n: NodePtr) -> Program {
        Program(ClvmObject::from_nodeptr(n))
    }
}

impl ToClvm<NodePtr> for Program {
    fn to_clvm(&self, encoder: &mut impl ClvmEncoder<Node = NodePtr>) -> Result<NodePtr, ToClvmError> {
        self.0.to_clvm(encoder)
    }
}

impl ToClvmObject for Program {
    fn to_clvm_obj(&self) -> ClvmObject {
        self.0.clone()
    }
}

#[derive(Clone)]
pub struct Puzzle(Program);

impl ToClvmObject for Puzzle {
    fn to_clvm_obj(&self) -> ClvmObject {
        self.0.to_clvm_obj()
    }
}

impl ToClvm<NodePtr> for Puzzle {
    fn to_clvm(&self, encoder: &mut impl ClvmEncoder<Node = NodePtr>) -> Result<NodePtr, ToClvmError> {
        self.to_clvm_obj().to_clvm(encoder)
    }
}

impl Puzzle {
    pub fn from_nodeptr(n: NodePtr) -> Puzzle {
        Puzzle(Program::from_nodeptr(n))
    }
}

#[derive(Clone)]
pub enum GameHandler {
    MyTurnHandler(ClvmObject),
    TheirTurnHandler(ClvmObject)
}

#[derive(Clone)]
pub struct Timeout(u64);

pub struct AllocEncoder<'a>(pub &'a mut Allocator);

impl<'a> ClvmEncoder for AllocEncoder<'a> {
    type Node = NodePtr;

    fn encode_atom(&mut self, bytes: &[u8]) -> Result<Self::Node, ToClvmError> {
        self.0.new_atom(bytes).map_err(|e| ToClvmError::Custom(format!("{e:?}")))
    }

    fn encode_pair(
        &mut self,
        first: Self::Node,
        rest: Self::Node
    ) -> Result<Self::Node, ToClvmError> {
        self.0.new_pair(first, rest).map_err(|e| ToClvmError::Custom(format!("{e:?}")))
    }
}


pub trait ErrToError {
    fn into_gen(self) -> Error;
}

impl ErrToError for EvalErr {
    fn into_gen(self) -> Error {
        Error::ClvmError(self)
    }
}

impl ErrToError for SyntaxErr {
    fn into_gen(self) -> Error {
        Error::SyntaxErr(self)
    }
}

impl ErrToError for io::Error {
    fn into_gen(self) -> Error {
        Error::IoError(self)
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

pub trait IntoErr<X> {
    fn into_gen(self) -> Result<X, Error>;
}

impl<X, E> IntoErr<X> for Result<X, E> where E: ErrToError {
    fn into_gen(self) -> Result<X, Error> {
        self.map_err(|e| e.into_gen())
    }
}
