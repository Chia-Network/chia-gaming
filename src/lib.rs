#![allow(
    clippy::redundant_field_names,
    clippy::uninlined_format_args,
    clippy::too_many_arguments
)]

#[macro_use]
pub mod common;
pub mod channel_state;
/// Provides as simple as possible a full blockchain interface that can be spoken
/// with via a trait interface that's either local and synchronous or over a pipe.
pub mod game_session;
pub mod games;
pub mod protocol_pretty;
mod referee;
pub mod session_phases;
pub mod shutdown;
#[cfg(feature = "sim-tests")]
pub mod simulator;
pub mod transaction_manager;
pub mod utils;

#[cfg(test)]
mod manifest_guards;

#[cfg(test)]
pub mod test_support;

// Sim-runner collectors (`test_funs`) are only referenced from `simulator`,
// which is feature-gated. Without `sim-tests`, `cargo test --no-run` still
// compiles this module (CI checks that config) but nothing calls the
// collectors — allow dead_code there so that check stays quiet.
#[cfg(test)]
#[cfg_attr(not(feature = "sim-tests"), allow(dead_code))]
mod tests;
