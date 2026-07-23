use crate::channel_state::types::ChannelEnv;
use crate::common::types::{CoinString, Error, Program, PuzzleHash, SpendBundle, Timeout};
use crate::session_phases::effects::{Effect, ResyncInfo};

/// Async interface implemented by Peer to receive notifications about wallet
/// state.
pub trait ChannelFundingWallet {
    /// Deliver the channel_puzzle_hash to the wallet.
    ///
    /// Only alice calls this.  Bob does not need this information because the
    /// information needed will be held at the level of the injected object instead.
    fn channel_puzzle_hash(&mut self, puzzle_hash: &PuzzleHash) -> Result<(), Error>;

    /// Tells the game layer that we received a partly funded offer to which we
    /// added our own coins and sent to the bootstrap wallet interface to use.
    /// We had previously received a partly funded spend bundle via the reply to
    /// channel_puzzle_hash,
    /// Should add a fee and try to spend.
    ///
    /// Asynchronously, channel_transaction_completion is delivered back to the
    /// potato handler.
    ///
    /// Only bob sends this, upon receiving message E, bob makes this call to
    /// inform the injected wallet bootstrap dependency that the spend bundle
    /// has been received (partly funded so far) and it is the job of the bootstrap
    /// wallet object injected dependency to finish funding this and actually
    /// spend it.
    fn received_channel_offer(&mut self, bundle: &SpendBundle) -> Result<(), Error>;
}

/// Spend wallet receiver
pub trait SpendWalletReceiver {
    fn coin_created(
        &mut self,
        env: &mut ChannelEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error>;
    fn coin_spent(
        &mut self,
        env: &mut ChannelEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error>;
    fn coin_puzzle_and_solution(
        &mut self,
        env: &mut ChannelEnv<'_>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error>;
}

/// Unroll time wallet interface.
pub trait WalletSpendInterface {
    /// Enqueue an outbound transaction.  `expiry` is the absolute height at/after
    /// which the bundle can no longer be included (threaded from the handler), or
    /// `None` when the bundle has no expiry.
    fn spend_transaction_and_add_fee(
        &mut self,
        bundle: &SpendBundle,
        expiry: Option<u64>,
    ) -> Result<(), Error>;

    /// Coin should report its lifecycle until it gets spent, then should be
    /// de-registered.
    fn register_coin(
        &mut self,
        coin_id: &CoinString,
        timeout: &Timeout,
        name: Option<&'static str>,
        spend: Option<SpendBundle>,
        semantic: Option<crate::session_phases::effects::TimeoutClaimSemantic>,
    ) -> Result<(), Error>;

    /// Request the puzzle and solution for a spent coin
    fn request_puzzle_and_solution(&mut self, coin_id: &CoinString) -> Result<(), Error>;
}
