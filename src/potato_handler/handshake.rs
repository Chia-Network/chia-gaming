use crate::common::types::{Aggsig, CoinString, PublicKey, PuzzleHash, SpendBundle};
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct HandshakeB {
    pub channel_public_key: PublicKey,
    pub unroll_public_key: PublicKey,
    pub reward_puzzle_hash: PuzzleHash,
    pub referee_pubkey: PublicKey,
    pub reward_payout_signature: Aggsig,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct HandshakeA {
    pub parent: CoinString,
    pub simple: HandshakeB,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandshakeStepInfo {
    pub first_player_hs_info: HandshakeA,
    pub second_player_hs_info: HandshakeB,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HandshakeStepWithSpend {
    pub info: HandshakeStepInfo,
    pub spend: SpendBundle,
}

#[derive(Debug, Serialize, Deserialize)]
pub enum ChannelState {
    Finished,
    Completed,
    Failed,
}
