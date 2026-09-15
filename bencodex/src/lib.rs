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

pub(crate) fn parse_integer(text: &str) -> Result<i128, Error> {
    let digits = text.strip_prefix('-').unwrap_or(text);
    let canonical = text == "0"
        || (digits
            .as_bytes()
            .first()
            .is_some_and(|digit| matches!(digit, b'1'..=b'9'))
            && digits.as_bytes()[1..]
                .iter()
                .all(|digit| digit.is_ascii_digit()));
    if !canonical {
        return Err(Error::InvalidData("invalid integer encoding".to_string()));
    }
    text.parse()
        .map_err(|_| Error::InvalidData(format!("cannot parse integer: {text}")))
}

#[cfg(test)]
mod tests;
