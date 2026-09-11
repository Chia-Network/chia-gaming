mod de;
mod error;
mod ser;
pub mod string_key_map;
mod value;

pub use de::from_slice;
pub use error::Error;
pub use ser::to_vec;
pub use value::{encode, parse, Value};

#[cfg(test)]
mod tests;
