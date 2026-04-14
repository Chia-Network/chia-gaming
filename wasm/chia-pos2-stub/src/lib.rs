pub const NUM_CHAIN_LINKS: usize = 16;

pub type Bytes32 = [u8; 32];

#[repr(C)]
#[derive(Clone, Default)]
pub struct QualityChain {
    pub chain_links: [u64; NUM_CHAIN_LINKS],
}

pub fn quality_string_from_proof(
    _plot_id: &[u8; 32],
    _k_size: u8,
    _strength: u8,
    _proof: &[u8],
) -> Option<QualityChain> {
    None
}

pub fn serialize_quality(
    fragments: &[u64; NUM_CHAIN_LINKS],
    strength: u8,
) -> [u8; NUM_CHAIN_LINKS * 8 + 1] {
    let mut ret = [0_u8; 129];
    ret[0] = strength;
    let mut idx = 1;
    for cl in fragments {
        ret[idx..(idx + 8)].clone_from_slice(&cl.to_le_bytes());
        idx += 8;
    }
    ret
}

pub struct Prover;

pub fn create_v2_plot() {
    unimplemented!("stub: not available in WASM builds")
}

pub fn solve_proof() {
    unimplemented!("stub: not available in WASM builds")
}

pub fn validate_proof_v2() {
    unimplemented!("stub: not available in WASM builds")
}
