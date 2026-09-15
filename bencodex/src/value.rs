use std::cmp::Ordering;

use crate::{parse_integer, parse_length, Error, Limits};

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
    parse_with_limits(input, Limits::default())
}

pub fn parse_with_limits(input: &[u8], limits: Limits) -> Result<Value, Error> {
    let mut parser = Parser {
        input,
        offset: 0,
        values: 0,
        limits,
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
    limits: Limits,
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
        if depth > self.limits.max_depth {
            return Err(Error::InvalidData(
                "maximum value nesting depth exceeded".to_string(),
            ));
        }
        self.values += 1;
        if self.values > self.limits.max_values {
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
        parse_integer(text).map(Value::Integer)
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
        let (length, prefix_length) = parse_length(&self.input[start..])?;
        self.offset = start + prefix_length;
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
        let limits = Limits::default();
        let mut nested = vec![b'l'; limits.max_depth + 2];
        nested.extend(std::iter::repeat_n(b'e', limits.max_depth + 2));
        assert!(parse(&nested).is_err());

        let mut wide = Vec::with_capacity(limits.max_values * 2 + 2);
        wide.push(b'l');
        for _ in 0..=limits.max_values {
            wide.extend_from_slice(b"0:");
        }
        wide.push(b'e');
        assert!(parse(&wide).is_err());
    }
}
