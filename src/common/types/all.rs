use std::borrow::Borrow;
use std::io;
use std::ops::Add;
use std::rc::Rc;

use log::debug;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use num_bigint::{BigInt, ToBigInt};

use rand::distributions::Standard;
use rand::prelude::*;

use clvmr::allocator::{NodePtr, SExp};
use clvmr::reduction::EvalErr;
use clvmr::serde::{node_from_bytes, node_to_bytes};
use clvmr::Allocator;
use clvmr::{run_program, ChiaDialect, NO_UNKNOWN_OPS};

use crate::utils::proper_list;

use crate::common::constants::{AGG_SIG_ME_ATOM, AGG_SIG_UNSAFE_ATOM, CREATE_COIN_ATOM, REM_ATOM};

use chia_bls;
use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};
use clvm_utils::tree_hash;

pub fn chia_dialect() -> ChiaDialect {
    ChiaDialect::new(NO_UNKNOWN_OPS)
}

use crate::common::types::coin_id::{atom_from_clvm, AllocEncoder, Hash};
use crate::common::types::coin_string::{u64_from_atom, Amount, CoinString, PuzzleHash};
use crate::common::types::error::Error;
use crate::common::types::private_key::{Aggsig, PublicKey};

impl Distribution<Hash> for Standard {
    fn sample<R: Rng + ?Sized>(&self, rng: &mut R) -> Hash {
        let mut pk = [0; 32];
        for item in &mut pk {
            *item = rng.gen();
        }
        Hash::from_bytes(pk)
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

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for GameID {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        encoder.encode_atom(clvm_traits::Atom::Borrowed(&self.0))
    }
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for Hash {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        encoder.encode_atom(clvm_traits::Atom::Borrowed(&self.0))
    }
}

impl std::fmt::Debug for Hash {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        write!(formatter, "Hash(")?;
        write!(formatter, "{}", hex::encode(self.0))?;
        write!(formatter, ")")
    }
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
        Node(allocator.nil())
    }
}

impl Node {
    pub fn to_hex(&self, allocator: &mut AllocEncoder) -> Result<String, Error> {
        let bytes = node_to_bytes(allocator.allocator(), self.0).into_gen()?;
        Ok(hex::encode(bytes))
    }
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for Node {
    fn to_clvm(&self, _encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
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

impl<X: ToClvm<AllocEncoder>> Sha256tree for X {
    fn sha256tree(&self, allocator: &mut AllocEncoder) -> PuzzleHash {
        self.to_clvm(allocator)
            .map(|node| PuzzleHash::from_bytes(tree_hash(allocator.allocator(), node).into()))
            .unwrap_or_default()
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
        let bytes = hex::decode(s.trim()).into_gen()?;
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

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ProgramRef(Rc<Program>);

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for ProgramRef {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        self.0.to_clvm(encoder)
    }
}

impl From<Rc<Program>> for ProgramRef {
    fn from(other: Rc<Program>) -> Self {
        ProgramRef::new(other)
    }
}

impl From<Program> for ProgramRef {
    fn from(other: Program) -> Self {
        ProgramRef::new(Rc::new(other))
    }
}

impl ProgramRef {
    pub fn new(p: Rc<Program>) -> Self {
        ProgramRef(p)
    }
    pub fn p(&self) -> Rc<Program> {
        self.0.clone()
    }
    pub fn pref(&self) -> &Program {
        self.0.borrow()
    }
    pub fn to_nodeptr(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        self.0.to_nodeptr(allocator)
    }
}

impl Serialize for ProgramRef {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.pref().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ProgramRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let ser: Program = Program::deserialize(deserializer)?;
        Ok(ProgramRef(Rc::new(ser)))
    }
}

fn clone_to_encoder<E: ClvmEncoder<Node = NodePtr>>(
    encoder: &mut E,
    source_allocator: &Allocator,
    node: <E as ClvmEncoder>::Node,
) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
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

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for Program {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        let mut allocator = Allocator::new();
        let result = node_from_bytes(&mut allocator, &self.0)
            .map_err(|e| ToClvmError::Custom(format!("{e:?}")))?;
        clone_to_encoder(encoder, &allocator, result)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Puzzle(ProgramRef);

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for Puzzle {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        self.0.to_clvm(encoder)
    }
}

impl From<Program> for Puzzle {
    fn from(other: Program) -> Self {
        Puzzle(other.into())
    }
}

impl From<Rc<Program>> for Puzzle {
    fn from(other: Rc<Program>) -> Self {
        Puzzle(other.into())
    }
}

impl From<ProgramRef> for Puzzle {
    fn from(other: ProgramRef) -> Self {
        Puzzle(other)
    }
}

impl Puzzle {
    pub fn to_program(&self) -> Rc<Program> {
        self.0.p()
    }
    pub fn from_bytes(by: &[u8]) -> Puzzle {
        Puzzle(Program::from_bytes(by).into())
    }
    pub fn from_nodeptr(allocator: &mut AllocEncoder, node: NodePtr) -> Result<Puzzle, Error> {
        let bytes = node_to_bytes(allocator.allocator(), node).into_gen()?;
        Ok(Puzzle::from_bytes(&bytes))
    }
    pub fn to_hex(&self) -> String {
        self.0 .0.to_hex()
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
        if let Some(amt) = atom_from_clvm(allocator, clvm).and_then(|a| u64_from_atom(&a)) {
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

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for Timeout {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        self.0.to_clvm(encoder)
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
            Node(conditions.1).to_hex(allocator)?
        );

        Ok(CoinCondition::from_nodeptr(allocator, conditions.1))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Spend {
    pub puzzle: Puzzle,
    pub solution: ProgramRef,
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
            puzzle: Puzzle::from_bytes(&[0x80]),
            solution: Program::from_bytes(&[0x80]).into(),
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

/// Maximum information about a coin spend.  Everything one might need downstream.
pub struct BrokenOutCoinSpendInfo {
    pub solution: ProgramRef,
    pub conditions: ProgramRef,
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

impl<E: ClvmEncoder<Node = NodePtr>, X: ToClvm<E>> ToClvm<E> for RcNode<X> {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
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
