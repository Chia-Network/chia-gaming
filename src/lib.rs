pub mod channel_handler;
mod common;
mod log;
pub mod outside;
/// Provides as simple as possible a full blockchain interface that can be spoken
/// with via a trait interface that's either local and synchronous or over a pipe.
pub mod peer_container;
mod referee;

#[cfg(test)]
mod tests;
