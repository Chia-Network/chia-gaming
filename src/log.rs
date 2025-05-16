pub fn init() {
    env_logger::init();
}

#[allow(unexpected_cfgs)]
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
#[ctor::ctor]
fn log_init() {
    init();
}
