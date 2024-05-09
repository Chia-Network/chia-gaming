use std::io;
use std::ops::{Add, AddAssign, Sub, SubAssign};

use num_bigint::{BigInt, Sign};
use num_traits::cast::ToPrimitive;

use rand::prelude::*;
use rand::distributions::Standard;

use sha2::{Sha256, Digest};

use clvmr::allocator::{Allocator, NodePtr, SExp};
use clvmr::reduction::EvalErr;

use clvm_tools_rs::classic::clvm::syntax_error::SyntaxErr;
use clvm_tools_rs::classic::clvm::sexp::proper_list;
use clvm_tools_rs::classic::clvm_tools::sha256tree::sha256tree;

use crate::common::constants::{AGG_SIG_UNSAFE_ATOM, AGG_SIG_ME_ATOM, CREATE_COIN_ATOM, REM_ATOM};

use clvm_traits::{ToClvm, ClvmEncoder, ToClvmError};
use chia_bls;
use chia_bls::signature::{sign, verify};

#[cfg(test)]
use clvm_tools_rs::compiler::runtypes::RunFailure;

/// CoinID
#[derive(Default, Clone)]
pub struct CoinID(Hash);

impl CoinID {
    pub fn new(h: Hash) -> CoinID { CoinID(h) }
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
        BigInt::from_bytes_be(Sign::Plus, amount_bytes).to_u64().map(|a| {
            (parent_id, puzzle_hash, Amount::new(a))
        })
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
        Ok(PrivateKey::from_bls(chia_bls::SecretKey::from_bytes(by).into_gen()?))
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
        for i in 0..32 {
            pk[i] = rng.gen();
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

/// Public key
#[derive(Clone, Eq, PartialEq, Debug)]
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

    pub fn from_slice(by: &[u8]) -> Result<Aggsig, Error> {
        if by.len() != 96 {
            return Err(Error::StrErr("bad aggsig length".to_string()));
        }
        let mut fixed: [u8; 96] = [0; 96];
        for (i,b) in by.iter().enumerate() {
            fixed[i % 96] = *b;
        }
        Aggsig::from_bytes(fixed)
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
    fn to_clvm(&self, encoder: &mut impl ClvmEncoder<Node = NodePtr>) -> Result<NodePtr, ToClvmError> {
        encoder.encode_atom(&self.0.to_bytes())
    }
}

/// Game ID
#[derive(Default, Clone, Debug, Eq, PartialEq)]
pub struct GameID(Vec<u8>);

impl GameID {
    pub fn new(s: Vec<u8>) -> GameID {
        GameID(s)
    }
}

impl GameID {
    pub fn from_bytes(s: &[u8]) -> GameID { GameID(s.to_vec()) }
}

/// Amount
#[derive(Default, Clone, Debug, Eq, PartialEq)]
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
        Sha256Input::Bytes(by).hash()
    }
    pub fn from_bytes(by: [u8; 32]) -> Hash {
        Hash(by)
    }
    pub fn from_slice(by: &[u8]) -> Hash {
        let mut fixed: [u8; 32] = [0; 32];
        for (i,b) in by.iter().enumerate() {
            fixed[i % 32] = *b;
        }
        Hash::from_bytes(fixed)
    }
    pub fn bytes<'a>(&'a self) -> &'a [u8; 32] {
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

impl<'a> Sha256Input<'a> {
    fn update(&self, hasher: &mut Sha256) {
        match self {
            Sha256Input::Bytes(b) => {
                hasher.update(b);
            }
            Sha256Input::Hash(hash) => {
                hasher.update(&hash.bytes());
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
#[derive(Default, Clone, Eq, PartialEq, Debug)]
pub struct PuzzleHash(Hash);

impl PuzzleHash {
    pub fn from_bytes(by: [u8; 32]) -> PuzzleHash {
        PuzzleHash(Hash::from_bytes(by))
    }
    pub fn from_hash(h: Hash) -> PuzzleHash {
        PuzzleHash(h)
    }
    pub fn bytes<'a>(&'a self) -> &'a [u8] {
        self.0.bytes()
    }
    pub fn hash<'a>(&'a self) -> &'a Hash {
        &self.0
    }
}

impl Distribution<PuzzleHash> for Standard {
    fn sample<R: Rng + ?Sized>(&self, rng: &mut R) -> PuzzleHash {
        PuzzleHash::from_hash(rng.gen())
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

#[derive(Clone, Debug)]
pub struct Node(pub NodePtr);

impl Default for Node {
    fn default() -> Node {
        let allocator = Allocator::new();
        Node(allocator.null())
    }
}

impl Node {
    pub fn new(n: NodePtr) -> Node { Node(n) }
    pub fn to_nodeptr(&self) -> NodePtr { self.0 }
}

impl ToClvm<NodePtr> for Node {
    fn to_clvm(&self, _encoder: &mut impl ClvmEncoder<Node = NodePtr>) -> Result<NodePtr, ToClvmError> {
        Ok(self.0)
    }
}

pub trait ToQuotedProgram {
    fn to_quoted_program(&self, allocator: &mut AllocEncoder) -> Result<Program, Error>;
}

impl ToQuotedProgram for NodePtr {
    fn to_quoted_program(&self, allocator: &mut AllocEncoder) -> Result<Program, Error> {
        let pair = allocator.0.new_pair(allocator.0.one(), *self).into_gen()?;
        Ok(Program::from_nodeptr(pair))
    }
}

pub trait Sha256tree {
    fn sha256tree(&self, allocator: &mut AllocEncoder) -> PuzzleHash;
}

impl<X: ToClvm<NodePtr>> Sha256tree for X {
    fn sha256tree(&self, allocator: &mut AllocEncoder) -> PuzzleHash {
        let node = self.to_clvm(allocator).unwrap_or_else(|_| allocator.0.null());
        let mut fixed: [u8; 32] = [0; 32];
        for (i, b) in sha256tree(allocator.allocator(), node).data().iter().enumerate() {
            fixed[i % 32] = *b;
        }
        PuzzleHash::from_bytes(fixed)
    }
}

#[derive(Clone)]
pub struct Program(NodePtr);

impl Program {
    pub fn from_nodeptr(n: NodePtr) -> Program {
        Program(n)
    }

    pub fn to_nodeptr(&self) -> NodePtr {
        self.0
    }
}

impl ToClvm<NodePtr> for Program {
    fn to_clvm(&self, _encoder: &mut impl ClvmEncoder<Node = NodePtr>) -> Result<NodePtr, ToClvmError> {
        Ok(self.0)
    }
}

#[derive(Clone)]
pub struct Puzzle(Program);

impl ToClvm<NodePtr> for Puzzle {
    fn to_clvm(&self, encoder: &mut impl ClvmEncoder<Node = NodePtr>) -> Result<NodePtr, ToClvmError> {
        self.0.to_clvm(encoder)
    }
}

impl Puzzle {
    pub fn to_nodeptr(&self) -> NodePtr { self.0.to_nodeptr() }
    pub fn from_nodeptr(n: NodePtr) -> Puzzle {
        Puzzle(Program::from_nodeptr(n))
    }
}

#[derive(Clone)]
pub struct Timeout(u64);

impl Timeout {
    pub fn new(t: u64) -> Self {
        Timeout(t)
    }
}

impl ToClvm<NodePtr> for Timeout {
    fn to_clvm(&self, encoder: &mut impl ClvmEncoder<Node = NodePtr>) -> Result<NodePtr, ToClvmError> {
        self.0.to_clvm(encoder)
    }
}

pub struct AllocEncoder(Allocator);

impl AllocEncoder {
    pub fn new() -> Self {
        AllocEncoder(Allocator::new())
    }

    pub fn allocator<'a>(&'a mut self) -> &'a mut Allocator {
        &mut self.0
    }
}

impl ClvmEncoder for AllocEncoder {
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

#[derive(Debug, Clone)]
pub enum CoinCondition {
    AggSigMe(PublicKey, Vec<u8>),
    AggSigUnsafe(PublicKey, Vec<u8>),
    CreateCoin(PuzzleHash),
    Rem(Vec<Vec<u8>>),
}

fn parse_condition(allocator: &mut AllocEncoder, condition: NodePtr) -> Option<CoinCondition> {
    let exploded =
        if let Some(pl) = proper_list(allocator.allocator(), condition, true) {
            pl
        } else {
            return None;
        };

    let public_key_from_bytes = |b: &[u8]| -> Result<PublicKey, Error> {
        let mut fixed: [u8; 48] = [0; 48];
        for (i,b) in b.iter().enumerate() {
            fixed[i % 48] = *b;
        }
        PublicKey::from_bytes(fixed)
    };
    if exploded.len() > 2 {
        if matches!(
            (allocator.allocator().sexp(exploded[0]),
             allocator.allocator().sexp(exploded[1]),
             allocator.allocator().sexp(exploded[2])
            ), (SExp::Atom, SExp::Atom, SExp::Atom)
        ) {
            let atoms: Vec<Vec<u8>> = exploded.iter().take(3).map(|a| {
                allocator.allocator().atom(*a).to_vec()
            }).collect();
            if *atoms[0] == AGG_SIG_UNSAFE_ATOM {
                if let Ok(pk) = public_key_from_bytes(&atoms[1]) {
                    return Some(CoinCondition::AggSigUnsafe(pk, atoms[2].to_vec()));
                }
            } else if *atoms[0] == AGG_SIG_ME_ATOM {
                if let Ok(pk) = public_key_from_bytes(&atoms[1]) {
                    return Some(CoinCondition::AggSigMe(pk, atoms[2].to_vec()));
                }
            } else if *atoms[0] == CREATE_COIN_ATOM {
                return Some(CoinCondition::CreateCoin(PuzzleHash::from_hash(Hash::from_slice(&atoms[1]))));
            } else if *atoms[0] == REM_ATOM {
                return Some(CoinCondition::Rem(atoms.iter().map(|a| a.to_vec()).collect()))
            }
        }
    }

    None
}

impl CoinCondition {
    pub fn from_nodeptr(allocator: &mut AllocEncoder, conditions: NodePtr) -> Vec<CoinCondition> {
        // Ensure this borrow of allocator is finished for what's next.
        if let Some(exploded) = proper_list(allocator.allocator(), conditions, true) {
            exploded.iter().flat_map(|cond| parse_condition(allocator, *cond)).collect()
        } else {
            Vec::new()
        }
    }
}

#[derive(Clone)]
pub struct TransactionBundle {
    pub puzzle: Puzzle,
    pub solution: NodePtr,
    pub signature: Aggsig
}

#[derive(Clone)]
pub struct SpecificTransactionBundle {
    pub coin: CoinString,
    pub bundle: TransactionBundle,
}


impl Default for TransactionBundle {
    fn default() -> Self {
        let allocator = Allocator::new();
        TransactionBundle {
            puzzle: Puzzle::from_nodeptr(allocator.null()),
            solution: allocator.null(),
            signature: Aggsig::default()
        }
    }
}

pub struct SpentResult {
    pub transaction_bundle: TransactionBundle,
    pub unroll_coin_string_up: CoinString,
    pub transaction_up: TransactionBundle,
    pub whether_has_timeout_up: bool
}

pub struct SpendRewardResult {
    pub coins_with_solutions: Vec<TransactionBundle>,
    pub result_coin_string_up: CoinString
}

pub fn usize_from_atom(a: &[u8]) -> Option<usize> {
    let bi = BigInt::from_bytes_be(Sign::Plus, a);
    bi.to_usize()
}

pub fn u64_from_atom(a: &[u8]) -> Option<u64> {
    let bi = BigInt::from_bytes_be(Sign::Plus, a);
    bi.to_u64()
}

pub fn atom_from_clvm<'a>(
    allocator: &'a mut AllocEncoder,
    n: NodePtr
) -> Option<&'a [u8]> {
    if matches!(allocator.allocator().sexp(n), SExp::Atom) {
        Some(allocator.allocator().atom(n))
    } else {
        None
    }
}
