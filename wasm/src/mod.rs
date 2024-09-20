use wasm_bindgen::prelude::*;

use chia_gaming::log::wasm_init;

#[wasm_bindgen]
pub fn init() {
    wasm_init();
}
