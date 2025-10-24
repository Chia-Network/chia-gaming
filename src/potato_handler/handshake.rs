use crate::common::types::{CoinString, PublicKey, PuzzleHash, SpendBundle};
use crate::potato_handler::on_chain::OnChainPotatoHandler;
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct HandshakeB {
    pub channel_public_key: PublicKey,
    pub unroll_public_key: PublicKey,
    pub reward_puzzle_hash: PuzzleHash,
    pub referee_puzzle_hash: PuzzleHash,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct HandshakeA {
    pub parent: CoinString,
    pub simple: HandshakeB,
}

#[derive(Debug, Clone)]
pub struct HandshakeStepInfo {
    pub first_player_hs_info: HandshakeA,
    #[allow(dead_code)]
    pub second_player_hs_info: HandshakeB,
}

#[derive(Debug, Clone)]
pub struct HandshakeStepWithSpend {
    pub info: HandshakeStepInfo,
    #[allow(dead_code)]
    pub spend: SpendBundle,
}

#[derive(Debug)]
pub enum HandshakeState {
    StepA,
    StepB,
    StepC(CoinString, Box<HandshakeA>),
    StepD(Box<HandshakeStepInfo>),
    StepE(Box<HandshakeStepInfo>),
    PostStepE(Box<HandshakeStepInfo>),
    StepF(Box<HandshakeStepInfo>),
    PostStepF(Box<HandshakeStepInfo>),
    Finished(Box<HandshakeStepWithSpend>),
    // Going on chain ourselves route.
    OnChainTransition(CoinString, Box<HandshakeStepWithSpend>),
    OnChainWaitingForUnrollTimeoutOrSpend(CoinString),
    // Other party went on chain, we're catching up route.
    OnChainWaitForConditions(CoinString, Box<HandshakeStepWithSpend>),
    // Converge here to on chain state.
    OnChainWaitingForUnrollSpend(CoinString),
    OnChainWaitingForUnrollConditions(CoinString),
    OnChain(Box<OnChainPotatoHandler>),
    Completed,
}
