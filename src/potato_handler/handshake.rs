use crate::channel_handler::types::PotatoSignatures;
use crate::common::types::{
    Aggsig, Amount, CoinID, CoinString, PublicKey, PuzzleHash, SpendBundle,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct HandshakeB {
    pub channel_public_key: PublicKey,
    pub unroll_public_key: PublicKey,
    pub reward_puzzle_hash: PuzzleHash,
    pub referee_pubkey: PublicKey,
    pub reward_payout_signature: Aggsig,
}

pub type HandshakeA = HandshakeB;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct HandshakeC {
    pub launcher_coin: CoinString,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct HandshakeD {
    pub signatures: PotatoSignatures,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandshakeStepInfo {
    pub first_player_hs_info: HandshakeB,
    pub second_player_hs_info: HandshakeB,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoinSpendRequest {
    pub amount: Amount,
    pub conditions: Vec<RawCoinCondition>,
    pub coin_id: Option<CoinID>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawCoinCondition {
    pub opcode: u32,
    pub args: Vec<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandshakeStepWithSpend {
    pub info: HandshakeStepInfo,
    pub spend: SpendBundle,
}
