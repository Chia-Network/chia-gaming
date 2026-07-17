#![allow(
    clippy::redundant_field_names,
    clippy::uninlined_format_args,
    clippy::too_many_arguments
)]

#[macro_use]
pub mod common;
pub mod channel_state;
pub mod games;
/// Provides as simple as possible a full blockchain interface that can be spoken
/// with via a trait interface that's either local and synchronous or over a pipe.
pub mod game_session;
pub mod session_phases;
pub mod protocol_pretty;
mod referee;
pub mod shutdown;
#[cfg(feature = "sim-tests")]
pub mod simulator;
pub mod transaction_manager;
pub mod utils;

#[cfg(test)]
mod manifest_guards;

#[cfg(test)]
pub mod test_support;

#[cfg(test)]
mod tests;
