mod de;
mod error;
mod ser;
pub mod string_key_map;
mod value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub max_depth: usize,
    pub max_values: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_depth: 512,
            max_values: 100_000,
        }
    }
}

pub use de::{from_slice, from_slice_with_limits};
pub use error::Error;
pub use ser::to_vec;
pub use value::{encode, parse, parse_with_limits, Value};

#[cfg(test)]
mod tests;
