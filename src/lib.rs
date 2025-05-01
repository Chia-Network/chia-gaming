#![allow(
  redundant_field_names,
  uninlined_format_args,
  too_many_arguments,
  manual_contains,
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
#[cfg(any(feature = "sim-tests", feature = "simulator"))]
pub mod simulator;
pub mod utils;

#[cfg(test)]
mod tests;
