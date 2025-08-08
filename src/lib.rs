#![allow(
    clippy::redundant_field_names,
    clippy::uninlined_format_args,
    clippy::too_many_arguments
)]

pub mod channel_handler;
pub mod common;
pub mod games;
pub mod log;
/// Provides as simple as possible a full blockchain interface that can be spoken
/// with via a trait interface that's either local and synchronous or over a pipe.
pub mod peer_container;
pub mod potato_handler;
mod referee;
pub mod shutdown;
#[cfg(feature = "sim-tests")]
pub mod simulator;
pub mod utils;

#[cfg(any(test, feature = "sim-tests"))]
pub mod test_support;

#[cfg(test)]
mod tests;
