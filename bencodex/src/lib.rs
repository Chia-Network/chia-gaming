mod ser;
mod de;
mod error;
pub mod string_key_map;

pub use error::Error;
pub use ser::to_vec;
pub use de::from_slice;

#[cfg(test)]
mod tests;
