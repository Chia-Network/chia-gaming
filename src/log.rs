use log::debug;
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use simplelog::{ColorChoice, TermLogger, TerminalMode};
use simplelog::{Config, LevelFilter, WriteLogger};
use std::io;

pub fn init<W: io::Write + Send + 'static>(writer: W) {
    let res = WriteLogger::init(LevelFilter::Debug, Config::default(), writer);
    debug!("logger: {res:?}");
}

#[allow(unexpected_cfgs)]
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
#[ctor::ctor]
fn log_init() {
    let rust_log = std::env::var("RUST_LOG")
        .map(|v| v.to_string())
        .unwrap_or_else(|_| "0".to_string());
    let filter = if rust_log == "debug" {
        LevelFilter::Debug
    } else {
        LevelFilter::Error
    };
    let _ = TermLogger::init(
        filter,
        Config::default(),
        TerminalMode::Mixed,
        ColorChoice::Auto,
    );
}
