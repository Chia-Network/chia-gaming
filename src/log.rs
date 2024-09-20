#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
#[ctor::ctor]
fn init() {
    env_logger::init();
}

#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
pub fn wasm_init() {
    env_logger::init();
}
