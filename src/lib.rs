pub mod channel_handler;
pub mod common;
pub mod games;
mod log;
pub mod outside;
/// Provides as simple as possible a full blockchain interface that can be spoken
/// with via a trait interface that's either local and synchronous or over a pipe.
pub mod peer_container;
mod referee;
#[cfg(any(feature = "sim-tests", feature = "simulator"))]
pub mod simulator;

#[cfg(test)]
mod tests;
