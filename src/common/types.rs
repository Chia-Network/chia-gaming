use std::io;

use rand::prelude::*;
use rand::distributions::Standard;

use clvmr::allocator::{Allocator, NodePtr};
use clvmr::reduction::EvalErr;

use clvm_tools_rs::classic::clvm::__type_compatibility__::{Bytes, BytesFromType, sha256};
use clvm_tools_rs::classic::clvm_tools::sha256tree;
use clvm_tools_rs::classic::clvm::syntax_error::SyntaxErr;

use clvm_traits::{ToClvm, ClvmEncoder, ToClvmError};
use chia_bls;
use chia_bls::signature::sign;

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
        let h = sha256(Bytes::new(Some(BytesFromType::Raw(self.0.clone()))));
        let mut fixed: [u8; 32] = [0; 32];
        for (i, b) in h.data().iter().enumerate() {
            fixed[i % fixed.len()] = *b;
        }
        CoinID(Hash::from_bytes(fixed))
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

impl PrivateKey {
    pub fn to_bls(&self) -> &chia_bls::SecretKey {
        &self.0
    }

    pub fn sign<Msg: AsRef<[u8]>>(&self, msg: Msg) -> Result<Aggsig, Error> {
        let sig = sign(&self.0, msg);
        Ok(Aggsig::from_bytes(sig.to_bytes()))
    }
}

/// Public key
#[derive(Clone, Eq, PartialEq)]
pub struct PublicKey([u8; 48]);

impl Default for PublicKey {
    fn default() -> Self {
        PublicKey([0; 48])
    }
}

impl PublicKey {
    pub fn to_bls(&self) -> Result<chia_bls::PublicKey, Error> {
        chia_bls::PublicKey::from_bytes(&self.0).into_gen()
    }

    pub fn bytes<'a>(&'a self) -> &'a [u8; 48] {
        &self.0
    }

    pub fn into_bytes(self) -> [u8; 48] {
        self.0
    }

    pub fn from_bytes(bytes: &[u8]) -> PublicKey {
        let mut fixed: [u8; 48] = [0; 48];
        for (i, b) in bytes.iter().enumerate() {
            fixed[i % fixed.len()] = *b;
        }
        PublicKey(fixed)
    }
}

                    impl ToClvm<NodePtr> for PublicKey {
                        fn to_clvm(&self, encoder: &mut impl ClvmEncoder<Node = NodePtr>) -> Result<NodePtr, ToClvmError> {
                            encoder.encode_atom(&self.0)
                        }
                    }

impl PublicKey {
    pub fn from_bls(pk: &chia_bls::PublicKey) -> PublicKey {
        PublicKey(pk.to_bytes())
    }
}

/// Aggsig
#[derive(Clone)]
pub struct Aggsig([u8; 96]);

impl Default for Aggsig {
    // Revisit for empty aggsig.
    fn default() -> Self {
        Aggsig([0; 96])
    }
}

impl Aggsig {
    pub fn from_bytes(by: [u8; 96]) -> Aggsig {
        Aggsig(by)
    }

    pub fn to_bls(&self) -> Result<chia_bls::Signature, Error> {
        chia_bls::Signature::from_bytes(&self.0).into_gen()
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

    pub fn add(&self, amt: &Amount) -> Amount {
        Amount(self.0 + amt.0)
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
    pub fn from_bytes(by: [u8; 32]) -> Hash {
        Hash(by)
    }
    pub fn bytes<'a>(&'a self) -> &'a [u8] {
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
    fn to_clvm(&self, encoder: &mut impl ClvmEncoder<Node = NodePtr>) -> Result<NodePtr, ToClvmError> {
        Ok(self.0)
    }
}

impl ClvmObject {
    pub fn from_nodeptr(p: NodePtr) -> ClvmObject {
        ClvmObject(p)
    }
    pub fn to_nodeptr(&self) -> NodePtr {
        self.0
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

impl ToClvmObject for Program {
    fn to_clvm_obj(&self) -> ClvmObject {
        self.0.clone()
    }
}

impl Program {
    pub fn from_nodeptr(n: NodePtr) -> Program {
        Program(ClvmObject::from_nodeptr(n))
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

    // Required methods
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
