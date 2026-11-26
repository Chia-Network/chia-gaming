//! Fee pricing for outbound transactions.
//!
//! The player chooses a fee rate in mojos per cost, and each transaction pays
//! that rate for its cost. Since chia-blockchain 2.7.6, farmers by default leave
//! transactions paying less than 4 mojos per cost out of the blocks they create.
//! The mempool still accepts those transactions, so they wait unconfirmed
//! without a rejection. A full mempool separately rejects anything below 5
//! mojos per cost. Like `chia_sdk_driver::minimum_fee` in the wallet SDK, a
//! nonzero rate is therefore at least 5, which passes both checks. A rate of
//! zero turns fees off.
//!
//! The wallet spend that pays a fee is part of the priced transaction, but it
//! does not exist until the wallet has been asked for a specific amount.
//! Requests therefore add an allowance for that spend, and finalization checks
//! the rate of the complete transaction.

pub use crate::common::protocol_timeout_bounds::FEE_SPEND_COST_ALLOWANCE;
use crate::common::protocol_timeout_bounds::{MIN_MOJOS_PER_COST, OPENING_COST_SHARE};
use crate::common::types::{Amount, SpendBundle};

pub fn minimum_fee(cost: u64) -> u64 {
    cost.saturating_mul(MIN_MOJOS_PER_COST)
}

/// The rate actually charged: zero, or at least the network minimum.
fn effective_rate(fee_per_cost: u64) -> u64 {
    if fee_per_cost == 0 {
        0
    } else {
        fee_per_cost.max(MIN_MOJOS_PER_COST)
    }
}

/// The fee to request for `bundle`: the rate for its cost plus the wallet spend
/// that will pay it. A bundle that cannot be priced pays for the allowance
/// alone.
pub fn attached_fee(fee_per_cost: u64, bundle: &SpendBundle, height: u64) -> Amount {
    let cost = bundle.consensus_cost(height).unwrap_or(0);
    Amount::new(
        effective_rate(fee_per_cost).saturating_mul(cost.saturating_add(FEE_SPEND_COST_ALLOWANCE)),
    )
}

/// The opening fee one player contributes, at the rate for that player's share
/// of the channel-opening transaction. Both players choose before either half
/// exists, so the share is a fixed upper estimate.
pub fn opening_fee(fee_per_cost: u64) -> Amount {
    Amount::new(effective_rate(fee_per_cost).saturating_mul(OPENING_COST_SHARE))
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
    fn opening_fee_charges_the_rate_for_a_share_of_the_opening() {
        assert_eq!(opening_fee(0), Amount::new(0));
        assert_eq!(opening_fee(1), Amount::new(300_000_000));
        assert_eq!(opening_fee(5), Amount::new(300_000_000));
        assert_eq!(opening_fee(10), Amount::new(600_000_000));
        assert_eq!(opening_fee(u64::MAX), Amount::new(u64::MAX));
    }
}
