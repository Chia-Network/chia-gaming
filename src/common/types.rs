use std::io;

use rand::prelude::*;
use rand::distributions::Standard;

use clvmr::allocator::{Allocator, NodePtr};
use clvmr::reduction::EvalErr;

use clvm_tools_rs::classic::clvm_tools::sha256tree;
use clvm_tools_rs::classic::clvm::syntax_error::SyntaxErr;

use clvm_traits::{ToClvm, ClvmEncoder, ToClvmError};
use chia_bls;

/// Coin String
#[derive(Default, Clone)]
pub struct CoinString(Vec<u8>);

/// Private Key
#[derive(Clone)]
pub struct PrivateKey([u8; 32]);

impl Default for PrivateKey {
    fn default() -> Self {
        PrivateKey([0; 32])
    }
}

/// Public key
#[derive(Clone)]
pub struct PublicKey([u8; 48]);

impl Default for PublicKey {
    fn default() -> Self {
        PublicKey([0; 48])
    }
}

impl PublicKey {
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

impl Distribution<PrivateKey> for Standard {
    fn sample<R: Rng + ?Sized>(&self, rng: &mut R) -> PrivateKey {
        let mut pk = [0; 32];
        for i in 0..32 {
            pk[i] = rng.gen();
        }
        PrivateKey(pk)
    }
}

/// Game ID
#[derive(Default, Clone)]
pub struct GameID(Vec<u8>);

/// Amount
#[derive(Default, Clone)]
pub struct Amount(u64);

#[derive(Clone, Eq, PartialEq, Debug)]
pub struct Hash([u8; 32]);

impl Default for Hash {
    fn default() -> Self {
        Hash([0; 32])
    }
}

impl Hash {
    pub fn bytes<'a>(&'a self) -> &'a [u8] {
        &self.0
    }
}

/// Puzzle hash
#[derive(Default, Clone, Eq, PartialEq, Debug)]
pub struct PuzzleHash(Hash);

impl PuzzleHash {
    pub fn bytes<'a>(&'a self) -> &'a [u8] {
        self.0.bytes()
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
    SyntaxErr(SyntaxErr),
    EncodeErr(ToClvmError),
    StrErr(String),
    BlsErr(chia_bls::Error),
    Channel
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

impl Default for Puzzle {
    fn default() -> Self {
        Puzzle(Program(ClvmObject(NodePtr(0))))
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

impl ErrToError for ToClvmError {
    fn into_gen(self) -> Error {
        Error::EncodeErr(self)
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

pub trait IntoErr<X> {
    fn into_gen(self) -> Result<X, Error>;
}

impl<X, E> IntoErr<X> for Result<X, E> where E: ErrToError {
    fn into_gen(self) -> Result<X, Error> {
        self.map_err(|e| e.into_gen())
    }
}
