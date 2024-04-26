/// Coin String
pub struct CoinString(Vec<u8>);

/// Private Key
pub struct PrivateKey([u8; 32]);

/// Public key
pub struct PublicKey([u8; 48]);

/// Aggsig
#[derive(Default)]
pub struct Aggsig([u8; 96]);

/// Game ID
pub struct GameID(Vec<u8>);

/// Amount
pub struct Amount(u64);

/// Puzzle hash
pub struct PuzzleHash([u8; 32]);

/// Referee ID
pub struct RefereeID(usize);
