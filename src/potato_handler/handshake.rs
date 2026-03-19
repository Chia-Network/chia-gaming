use crate::channel_handler::types::PotatoSignatures;
use crate::common::types::{
    Aggsig, Amount, CoinID, CoinString, PublicKey, PuzzleHash, SpendBundle,
};
use crate::potato_handler::on_chain::OnChainGameHandler;
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

#[derive(Debug, Serialize, Deserialize)]
pub enum ChannelState {
    // -- Handshake states --
    StepA,
    StepB,
    WaitForBobKeys(Box<HandshakeB>),
    WaitForLauncher(Box<HandshakeStepInfo>),
    WaitForCoinId(Box<HandshakeStepInfo>),
    WaitForBobSigs(Box<HandshakeStepInfo>),
    WaitForAliceSpend(Box<HandshakeStepInfo>, PotatoSignatures),
    WaitForOffer(Box<HandshakeStepInfo>),
    WaitForBobSpend(Box<HandshakeStepInfo>, SpendBundle),
    WaitForCompletion(Box<HandshakeStepInfo>),

    // -- Post-handshake states --
    Finished(Box<HandshakeStepWithSpend>),
    OnChainWaitingForUnrollTimeoutOrSpend(CoinString, usize),
    OnChainWaitForConditions(CoinString, Box<HandshakeStepWithSpend>),
    OnChainWaitingForUnrollSpend(CoinString, usize, Option<CoinString>),
    OnChainWaitingForUnrollConditions(CoinString, usize),
    CleanShutdownWaitForConditions(CoinString, Option<CoinString>),
    OnChain(Box<OnChainGameHandler>),
    Completed,
    Failed,
}

pub fn encode_u64_as_clvm_int(val: u64) -> Vec<u8> {
    if val == 0 {
        return vec![];
    }
    let mut bytes = Vec::new();
    let mut h = val;
    while h > 0 {
        bytes.push((h & 0xff) as u8);
        h >>= 8;
    }
    bytes.reverse();
    if bytes[0] & 0x80 != 0 {
        bytes.insert(0, 0);
    }
    bytes
}

pub fn decode_clvm_int_to_u64(bytes: &[u8]) -> u64 {
    if bytes.is_empty() {
        return 0;
    }
    let mut result: u64 = 0;
    for &b in bytes {
        result = (result << 8) | (b as u64);
    }
    result
}
