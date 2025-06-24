use log::debug;
use std::io;
use simplelog::{Config, ColorChoice, TermLogger, TerminalMode, WriteLogger, LevelFilter};

pub fn init<W: io::Write + Send + 'static>(writer: W) {
    let res = WriteLogger::init(
        LevelFilter::Debug,
        Config::default(),
        writer
    );
    debug!("logger: {res:?}");
}

#[allow(unexpected_cfgs)]
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
#[ctor::ctor]
fn log_init() {
    let _ = TermLogger::init(
        LevelFilter::Debug,
        Config::default(),
        TerminalMode::Mixed,
        ColorChoice::Auto
    );
}
