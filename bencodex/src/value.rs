use std::cmp::Ordering;

use crate::Error;

const MAX_PARSE_DEPTH: usize = 512;
const MAX_PARSE_VALUES: usize = 100_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    Null,
    Bool(bool),
    Integer(i128),
    Bytes(Vec<u8>),
    Text(String),
    List(Vec<Value>),
    Dictionary(Vec<(Value, Value)>),
}

pub fn encode(value: &Value) -> Result<Vec<u8>, Error> {
    let mut out = Vec::new();
    encode_into(value, &mut out)?;
    Ok(out)
}

pub fn parse(input: &[u8]) -> Result<Value, Error> {
    let mut parser = Parser {
        input,
        offset: 0,
        values: 0,
    };
    let value = parser.value(0)?;
    if parser.offset != input.len() {
        return Err(Error::InvalidData(format!(
            "{} trailing bytes after value",
            input.len() - parser.offset
        )));
    }
    Ok(value)
}

fn key_cmp(left: &Value, right: &Value) -> Result<Ordering, Error> {
    match (left, right) {
        (Value::Bytes(left), Value::Bytes(right)) => Ok(left.cmp(right)),
        (Value::Text(left), Value::Text(right)) => Ok(left.as_bytes().cmp(right.as_bytes())),
        (Value::Bytes(_), Value::Text(_)) => Ok(Ordering::Less),
        (Value::Text(_), Value::Bytes(_)) => Ok(Ordering::Greater),
        _ => Err(Error::InvalidData(
            "dictionary keys must be bytes or text".to_string(),
        )),
    }
}

fn encode_into(value: &Value, out: &mut Vec<u8>) -> Result<(), Error> {
    match value {
        Value::Null => out.push(b'n'),
        Value::Bool(value) => out.push(if *value { b't' } else { b'f' }),
        Value::Integer(value) => {
            out.push(b'i');
            out.extend_from_slice(value.to_string().as_bytes());
            out.push(b'e');
        }
        Value::Bytes(value) => write_sized(value, out),
        Value::Text(value) => {
            out.push(b'u');
            write_sized(value.as_bytes(), out);
        }
        Value::List(values) => {
            out.push(b'l');
            for value in values {
                encode_into(value, out)?;
            }
            out.push(b'e');
        }
        Value::Dictionary(entries) => {
            let mut entries = entries.iter().collect::<Vec<_>>();
            entries
                .sort_by(|(left, _), (right, _)| key_cmp(left, right).unwrap_or(Ordering::Equal));
            for pair in entries.windows(2) {
                if key_cmp(&pair[0].0, &pair[1].0)? != Ordering::Less {
                    return Err(Error::InvalidData("duplicate dictionary key".to_string()));
                }
            }
            out.push(b'd');
            for (key, value) in entries {
                key_cmp(key, key)?;
                encode_into(key, out)?;
                encode_into(value, out)?;
            }
            out.push(b'e');
        }
    }
    Ok(())
}

fn write_sized(bytes: &[u8], out: &mut Vec<u8>) {
    out.extend_from_slice(bytes.len().to_string().as_bytes());
    out.push(b':');
    out.extend_from_slice(bytes);
}

struct Parser<'a> {
    input: &'a [u8],
    offset: usize,
    values: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Result<u8, Error> {
        self.input.get(self.offset).copied().ok_or(Error::Eof)
    }

    fn take(&mut self) -> Result<u8, Error> {
        let byte = self.peek()?;
        self.offset += 1;
        Ok(byte)
    }

    fn value(&mut self, depth: usize) -> Result<Value, Error> {
        if depth > MAX_PARSE_DEPTH {
            return Err(Error::InvalidData(
                "maximum value nesting depth exceeded".to_string(),
            ));
        }
        self.values += 1;
        if self.values > MAX_PARSE_VALUES {
            return Err(Error::InvalidData(
                "maximum value count exceeded".to_string(),
            ));
        }
        match self.take()? {
            b'n' => Ok(Value::Null),
            b't' => Ok(Value::Bool(true)),
            b'f' => Ok(Value::Bool(false)),
            b'i' => self.integer(),
            b'l' => self.list(depth),
            b'd' => self.dictionary(depth),
            b'u' => {
                let bytes = self.sized()?;
                let text = String::from_utf8(bytes)
                    .map_err(|_| Error::InvalidData("invalid utf-8 text".to_string()))?;
                Ok(Value::Text(text))
            }
            digit @ b'0'..=b'9' => Ok(Value::Bytes(self.sized_after_first(digit)?)),
            byte => Err(Error::InvalidData(format!("unexpected byte: 0x{byte:02x}"))),
        }
    }

    fn integer(&mut self) -> Result<Value, Error> {
        let start = self.offset;
        while self.peek()? != b'e' {
            self.offset += 1;
        }
        let digits = &self.input[start..self.offset];
        self.offset += 1;
        let text = std::str::from_utf8(digits)
            .map_err(|_| Error::InvalidData("non-utf8 integer".to_string()))?;
        if text.is_empty()
            || text == "-0"
            || text.starts_with("-0")
            || (text.starts_with('0') && text.len() > 1)
            || (text.starts_with('-') && text.len() == 1)
        {
            return Err(Error::InvalidData("invalid integer encoding".to_string()));
        }
        text.parse::<i128>()
            .map(Value::Integer)
            .map_err(|_| Error::InvalidData(format!("cannot parse integer: {text}")))
    }

    fn sized(&mut self) -> Result<Vec<u8>, Error> {
        let first = self.take()?;
        if !first.is_ascii_digit() {
            return Err(Error::InvalidData("missing string length".to_string()));
        }
        self.sized_after_first(first)
    }

    fn sized_after_first(&mut self, _first: u8) -> Result<Vec<u8>, Error> {
        let start = self.offset - 1;
        while self.peek()? != b':' {
            if !self.take()?.is_ascii_digit() {
                return Err(Error::InvalidData("invalid string length".to_string()));
            }
        }
        let end = self.offset;
        self.offset += 1;
        let digits = &self.input[start..end];
        if digits.len() > 1 && digits[0] == b'0' {
            return Err(Error::InvalidData(
                "non-canonical string length".to_string(),
            ));
        }
        let length = std::str::from_utf8(digits)
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .ok_or_else(|| Error::InvalidData("invalid string length".to_string()))?;
        let end = self.offset.checked_add(length).ok_or(Error::Eof)?;
        let bytes = self.input.get(self.offset..end).ok_or(Error::Eof)?.to_vec();
        self.offset = end;
        Ok(bytes)
    }

    fn list(&mut self, depth: usize) -> Result<Value, Error> {
        let mut values = Vec::new();
        while self.peek()? != b'e' {
            values.push(self.value(depth + 1)?);
        }
        self.offset += 1;
        Ok(Value::List(values))
    }

    fn dictionary(&mut self, depth: usize) -> Result<Value, Error> {
        let mut entries = Vec::new();
        while self.peek()? != b'e' {
            let key = self.value(depth + 1)?;
            if !matches!(key, Value::Bytes(_) | Value::Text(_)) {
                return Err(Error::InvalidData(
                    "dictionary keys must be bytes or text".to_string(),
                ));
            }
            if let Some((previous, _)) = entries.last() {
                if key_cmp(previous, &key)? != Ordering::Less {
                    return Err(Error::InvalidData(
                        "dictionary keys are not in canonical order".to_string(),
                    ));
                }
            }
            let value = self.value(depth + 1)?;
            entries.push((key, value));
        }
        self.offset += 1;
        Ok(Value::Dictionary(entries))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dictionaries_encode_in_canonical_key_order() {
        let value = Value::Dictionary(vec![
            (Value::Text("z".into()), Value::Integer(3)),
            (Value::Bytes(b"z".to_vec()), Value::Integer(2)),
            (Value::Text("a".into()), Value::Integer(1)),
        ]);
        assert_eq!(encode(&value).unwrap(), b"d1:zi2eu1:ai1eu1:zi3ee");
    }

    #[test]
    fn parse_rejects_malformed_noncanonical_and_trailing_data() {
        for input in [
            b"i01e".as_slice(),
            b"01:x".as_slice(),
            b"du1:bi1eu1:ai2ee".as_slice(),
            b"du1:ai1eu1:ai2ee".as_slice(),
            b"li1e".as_slice(),
            b"nx".as_slice(),
        ] {
            assert!(parse(input).is_err(), "{input:?}");
        }
    }

    #[test]
    fn parse_rejects_excessive_depth_and_value_count() {
        let mut nested = vec![b'l'; MAX_PARSE_DEPTH + 2];
        nested.extend(std::iter::repeat_n(b'e', MAX_PARSE_DEPTH + 2));
        assert!(parse(&nested).is_err());

        let mut wide = Vec::with_capacity(MAX_PARSE_VALUES * 2 + 2);
        wide.push(b'l');
        for _ in 0..=MAX_PARSE_VALUES {
            wide.extend_from_slice(b"0:");
        }
        wide.push(b'e');
        assert!(parse(&wide).is_err());
    }
}
