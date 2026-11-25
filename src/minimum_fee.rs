//! Minimum fee pricing for outbound transactions.
//!
//! Since chia-blockchain 2.7.6, farmers by default leave transactions paying
//! less than 4 mojos per cost out of the blocks they create. The mempool still
//! accepts those transactions, so they wait unconfirmed without a rejection. A
//! full mempool separately rejects anything below 5 mojos per cost. Like
//! `chia_sdk_driver::minimum_fee` in the wallet SDK, this prices at 5, which
//! passes both checks.
//!
//! The wallet spend that pays a fee is part of the priced transaction, but it
//! does not exist until the wallet has been asked for a specific amount.
//! Requests therefore add an allowance for that spend, and finalization checks
//! the rate of the complete transaction.

use crate::common::protocol_timeout_bounds::{MIN_MOJOS_PER_COST, OPENING_COST_SHARE};
use crate::common::types::{Amount, SpendBundle};

/// Cost reserved for the wallet spend that pays an attached fee. This covers a
/// WalletConnect offer with its settlement and nil spends (about 18M) and a
/// simple Cloud Wallet vault spend (about 39M in the wallet SDK's vault tests).
pub const FEE_SPEND_COST_ALLOWANCE: u64 = 45_000_000;

/// How long a fee offer stays valid: 10 minutes at 18.75 seconds per block.
pub const FEE_OFFER_EXPIRY_BLOCKS: u64 = 32;

pub fn minimum_fee(cost: u64) -> u64 {
    cost.saturating_mul(MIN_MOJOS_PER_COST)
}

/// The fee to request for `bundle`: `configured`, raised to the minimum for the
/// bundle plus the wallet spend that will pay it. Zero opts out of fees and is
/// never raised. A bundle that cannot be priced keeps the configured amount.
pub fn attached_fee(configured: &Amount, bundle: &SpendBundle, height: u64) -> Amount {
    if configured.to_u64() == 0 {
        return configured.clone();
    }
    let Ok(cost) = bundle.consensus_cost(height) else {
        return configured.clone();
    };
    let minimum = minimum_fee(cost.saturating_add(FEE_SPEND_COST_ALLOWANCE));
    Amount::new(configured.to_u64().max(minimum))
}

/// The opening fee one player contributes: `configured`, raised to the minimum
/// for that player's share of the channel-opening transaction. Both players
/// choose before either half exists, so the share is a fixed upper estimate.
pub fn opening_fee(configured: &Amount) -> Amount {
    if configured.to_u64() == 0 {
        return configured.clone();
    }
    Amount::new(configured.to_u64().max(minimum_fee(OPENING_COST_SHARE)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimum_fee_is_five_mojos_per_cost() {
        assert_eq!(minimum_fee(0), 0);
        assert_eq!(minimum_fee(50_000_000), 250_000_000);
        assert_eq!(minimum_fee(u64::MAX), u64::MAX);
    }

    #[test]
    fn opening_fee_is_raised_to_the_minimum_unless_fees_are_disabled() {
        assert_eq!(opening_fee(&Amount::new(0)), Amount::new(0));
        assert_eq!(opening_fee(&Amount::new(1)), Amount::new(300_000_000));
        assert_eq!(
            opening_fee(&Amount::new(400_000_000)),
            Amount::new(400_000_000)
        );
    }
}
