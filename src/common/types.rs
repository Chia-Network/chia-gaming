use rand::prelude::*;
use rand::distributions::Standard;

use clvmr::allocator::NodePtr;
use clvmr::reduction::EvalErr;

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

#[derive(Clone)]
pub struct Hash([u8; 32]);

impl Default for Hash {
    fn default() -> Self {
        Hash([0; 32])
    }
}

/// Puzzle hash
#[derive(Default, Clone)]
pub struct PuzzleHash(Hash);

/// Referee ID
#[derive(Default, Clone)]
pub struct RefereeID(usize);

/// Error type
#[derive(Clone)]
pub enum Error {
    ClvmError(EvalErr),
    Channel
}

#[derive(Clone)]
pub struct ClvmObject(NodePtr);

#[derive(Clone)]
pub struct Program(ClvmObject);

#[derive(Clone)]
pub struct Puzzle(Program);

#[derive(Clone)]
pub enum GameHandler {
    MyTurnHandler(ClvmObject),
    TheirTurnHandler(ClvmObject)
}

#[derive(Clone)]
pub struct Timeout(u64);
