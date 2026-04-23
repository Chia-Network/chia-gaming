use serde::de::{self, Deserialize, DeserializeSeed, MapAccess, SeqAccess, Visitor};

use crate::Error;

pub fn from_slice<'de, T: Deserialize<'de>>(input: &'de [u8]) -> Result<T, Error> {
    let mut de = Deserializer { input };
    let value = T::deserialize(&mut de)?;
    if de.input.is_empty() {
        Ok(value)
    } else {
        Err(Error::InvalidData(format!(
            "{} trailing bytes after value",
            de.input.len()
        )))
    }
}

struct Deserializer<'de> {
    input: &'de [u8],
}

impl<'de> Deserializer<'de> {
    fn peek(&self) -> Result<u8, Error> {
        self.input.first().copied().ok_or(Error::Eof)
    }

    fn advance(&mut self, n: usize) {
        self.input = &self.input[n..];
    }

    fn consume_end(&mut self) -> Result<(), Error> {
        if self.peek()? == b'e' {
            self.advance(1);
            Ok(())
        } else {
            Err(Error::InvalidData(format!(
                "expected 'e' terminator, got 0x{:02x}",
                self.peek()?
            )))
        }
    }

    fn parse_int_value(&mut self) -> Result<i128, Error> {
        // Already consumed the leading 'i'
        let end = self.input.iter().position(|&b| b == b'e')
            .ok_or_else(|| Error::InvalidData("unterminated integer".into()))?;
        let digits = &self.input[..end];
        let s = std::str::from_utf8(digits)
            .map_err(|_| Error::InvalidData("non-utf8 in integer".into()))?;
        if s.starts_with("-0") || (s.starts_with('0') && s.len() > 1) {
            return Err(Error::InvalidData("invalid integer encoding".into()));
        }
        let val: i128 = s.parse()
            .map_err(|_| Error::InvalidData(format!("cannot parse integer: {s}")))?;
        self.advance(end + 1);
        Ok(val)
    }

    fn parse_bytestring(&mut self) -> Result<&'de [u8], Error> {
        let colon = self.input.iter().position(|&b| b == b':')
            .ok_or_else(|| Error::InvalidData("missing ':' in bytestring".into()))?;
        let len_str = std::str::from_utf8(&self.input[..colon])
            .map_err(|_| Error::InvalidData("non-utf8 in bytestring length".into()))?;
        let len: usize = len_str.parse()
            .map_err(|_| Error::InvalidData(format!("bad bytestring length: {len_str}")))?;
        let start = colon + 1;
        if self.input.len() < start + len {
            return Err(Error::Eof);
        }
        let data = &self.input[start..start + len];
        self.advance(start + len);
        Ok(data)
    }

    fn parse_unicode(&mut self) -> Result<&'de str, Error> {
        // 'u' already consumed
        let bytes = self.parse_bytestring()?;
        std::str::from_utf8(bytes)
            .map_err(|_| Error::InvalidData("invalid utf-8 in unicode string".into()))
    }
}

impl<'de, 'a> de::Deserializer<'de> for &'a mut Deserializer<'de> {
    type Error = Error;

    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self.peek()? {
            b'n' => {
                self.advance(1);
                visitor.visit_unit()
            }
            b't' => {
                self.advance(1);
                visitor.visit_bool(true)
            }
            b'f' => {
                self.advance(1);
                visitor.visit_bool(false)
            }
            b'i' => {
                self.advance(1);
                let val = self.parse_int_value()?;
                if val >= 0 && val <= u64::MAX as i128 {
                    visitor.visit_u64(val as u64)
                } else if val >= i64::MIN as i128 && val < 0 {
                    visitor.visit_i64(val as i64)
                } else {
                    visitor.visit_i128(val)
                }
            }
            b'l' => {
                self.advance(1);
                let result = visitor.visit_seq(ListAccess { de: self })?;
                self.consume_end()?;
                Ok(result)
            }
            b'd' => {
                self.advance(1);
                let result = visitor.visit_map(DictAccess { de: self })?;
                self.consume_end()?;
                Ok(result)
            }
            b'u' => {
                self.advance(1);
                let s = self.parse_unicode()?;
                visitor.visit_borrowed_str(s)
            }
            b'0'..=b'9' => {
                let bytes = self.parse_bytestring()?;
                visitor.visit_borrowed_bytes(bytes)
            }
            other => Err(Error::InvalidData(format!("unexpected byte: 0x{other:02x}"))),
        }
    }

    fn deserialize_bool<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self.peek()? {
            b't' => { self.advance(1); visitor.visit_bool(true) }
            b'f' => { self.advance(1); visitor.visit_bool(false) }
            _ => self.deserialize_any(visitor),
        }
    }

    fn deserialize_i8<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> { self.deserialize_any(visitor) }
    fn deserialize_i16<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> { self.deserialize_any(visitor) }
    fn deserialize_i32<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> { self.deserialize_any(visitor) }
    fn deserialize_i64<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> { self.deserialize_any(visitor) }
    fn deserialize_i128<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> { self.deserialize_any(visitor) }
    fn deserialize_u8<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> { self.deserialize_any(visitor) }
    fn deserialize_u16<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> { self.deserialize_any(visitor) }
    fn deserialize_u32<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> { self.deserialize_any(visitor) }
    fn deserialize_u64<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> { self.deserialize_any(visitor) }
    fn deserialize_u128<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> { self.deserialize_any(visitor) }
    fn deserialize_f32<V: Visitor<'de>>(self, _visitor: V) -> Result<V::Value, Error> {
        Err(Error::Message("bencodex does not support floats".into()))
    }
    fn deserialize_f64<V: Visitor<'de>>(self, _visitor: V) -> Result<V::Value, Error> {
        Err(Error::Message("bencodex does not support floats".into()))
    }
    fn deserialize_char<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> { self.deserialize_any(visitor) }
    fn deserialize_str<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> { self.deserialize_any(visitor) }
    fn deserialize_string<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> { self.deserialize_any(visitor) }

    fn deserialize_bytes<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self.peek()? {
            b'0'..=b'9' => {
                let bytes = self.parse_bytestring()?;
                visitor.visit_borrowed_bytes(bytes)
            }
            _ => self.deserialize_any(visitor),
        }
    }

    fn deserialize_byte_buf<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        self.deserialize_bytes(visitor)
    }

    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        if self.peek()? == b'n' {
            self.advance(1);
            visitor.visit_none()
        } else {
            visitor.visit_some(self)
        }
    }

    fn deserialize_unit<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        if self.peek()? == b'n' {
            self.advance(1);
            visitor.visit_unit()
        } else {
            self.deserialize_any(visitor)
        }
    }

    fn deserialize_unit_struct<V: Visitor<'de>>(self, _name: &'static str, visitor: V) -> Result<V::Value, Error> {
        self.deserialize_unit(visitor)
    }

    fn deserialize_newtype_struct<V: Visitor<'de>>(self, _name: &'static str, visitor: V) -> Result<V::Value, Error> {
        visitor.visit_newtype_struct(self)
    }

    fn deserialize_seq<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        if self.peek()? == b'l' {
            self.advance(1);
            let result = visitor.visit_seq(ListAccess { de: self })?;
            self.consume_end()?;
            Ok(result)
        } else {
            self.deserialize_any(visitor)
        }
    }

    fn deserialize_tuple<V: Visitor<'de>>(self, _len: usize, visitor: V) -> Result<V::Value, Error> {
        self.deserialize_seq(visitor)
    }

    fn deserialize_tuple_struct<V: Visitor<'de>>(self, _name: &'static str, _len: usize, visitor: V) -> Result<V::Value, Error> {
        self.deserialize_seq(visitor)
    }

    fn deserialize_map<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        if self.peek()? == b'd' {
            self.advance(1);
            let result = visitor.visit_map(DictAccess { de: self })?;
            self.consume_end()?;
            Ok(result)
        } else {
            self.deserialize_any(visitor)
        }
    }

    fn deserialize_struct<V: Visitor<'de>>(
        self,
        _name: &'static str,
        _fields: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Error> {
        self.deserialize_map(visitor)
    }

    fn deserialize_enum<V: Visitor<'de>>(
        self,
        _name: &'static str,
        _variants: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Error> {
        match self.peek()? {
            b'u' => {
                // Unit variant: just a unicode string
                visitor.visit_enum(UnitVariantAccess { de: self })
            }
            b'd' => {
                // Newtype/struct/tuple variant: dict with one key
                self.advance(1);
                visitor.visit_enum(DictVariantAccess { de: self })
            }
            _ => self.deserialize_any(visitor),
        }
    }

    fn deserialize_identifier<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self.peek()? {
            b'u' => {
                self.advance(1);
                let s = self.parse_unicode()?;
                visitor.visit_borrowed_str(s)
            }
            b'0'..=b'9' => {
                let bytes = self.parse_bytestring()?;
                match std::str::from_utf8(bytes) {
                    Ok(s) => visitor.visit_borrowed_str(s),
                    Err(_) => visitor.visit_borrowed_bytes(bytes),
                }
            }
            _ => self.deserialize_any(visitor),
        }
    }

    fn deserialize_ignored_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        self.deserialize_any(visitor)
    }
}

// --- List (sequence) access ---

struct ListAccess<'a, 'de> {
    de: &'a mut Deserializer<'de>,
}

impl<'a, 'de> SeqAccess<'de> for ListAccess<'a, 'de> {
    type Error = Error;

    fn next_element_seed<T: DeserializeSeed<'de>>(&mut self, seed: T) -> Result<Option<T::Value>, Error> {
        if self.de.peek()? == b'e' {
            return Ok(None);
        }
        seed.deserialize(&mut *self.de).map(Some)
    }
}

// --- Dict (map/struct) access ---

struct DictAccess<'a, 'de> {
    de: &'a mut Deserializer<'de>,
}

impl<'a, 'de> MapAccess<'de> for DictAccess<'a, 'de> {
    type Error = Error;

    fn next_key_seed<K: DeserializeSeed<'de>>(&mut self, seed: K) -> Result<Option<K::Value>, Error> {
        if self.de.peek()? == b'e' {
            return Ok(None);
        }
        seed.deserialize(&mut *self.de).map(Some)
    }

    fn next_value_seed<V: DeserializeSeed<'de>>(&mut self, seed: V) -> Result<V::Value, Error> {
        seed.deserialize(&mut *self.de)
    }
}

// --- Enum access: unit variant (bare unicode string) ---

struct UnitVariantAccess<'a, 'de> {
    de: &'a mut Deserializer<'de>,
}

impl<'a, 'de> de::EnumAccess<'de> for UnitVariantAccess<'a, 'de> {
    type Error = Error;
    type Variant = UnitOnly;

    fn variant_seed<V: DeserializeSeed<'de>>(self, seed: V) -> Result<(V::Value, UnitOnly), Error> {
        let val = seed.deserialize(&mut *self.de)?;
        Ok((val, UnitOnly))
    }
}

struct UnitOnly;

impl<'de> de::VariantAccess<'de> for UnitOnly {
    type Error = Error;
    fn unit_variant(self) -> Result<(), Error> { Ok(()) }
    fn newtype_variant_seed<T: DeserializeSeed<'de>>(self, _seed: T) -> Result<T::Value, Error> {
        Err(Error::Message("expected unit variant".into()))
    }
    fn tuple_variant<V: Visitor<'de>>(self, _len: usize, _visitor: V) -> Result<V::Value, Error> {
        Err(Error::Message("expected unit variant".into()))
    }
    fn struct_variant<V: Visitor<'de>>(self, _fields: &'static [&'static str], _visitor: V) -> Result<V::Value, Error> {
        Err(Error::Message("expected unit variant".into()))
    }
}

// --- Enum access: dict variant (one-key dict) ---

struct DictVariantAccess<'a, 'de> {
    de: &'a mut Deserializer<'de>,
}

impl<'a, 'de> de::EnumAccess<'de> for DictVariantAccess<'a, 'de> {
    type Error = Error;
    type Variant = DictVariantValue<'a, 'de>;

    fn variant_seed<V: DeserializeSeed<'de>>(self, seed: V) -> Result<(V::Value, DictVariantValue<'a, 'de>), Error> {
        let val = seed.deserialize(&mut *self.de)?;
        Ok((val, DictVariantValue { de: self.de }))
    }
}

struct DictVariantValue<'a, 'de> {
    de: &'a mut Deserializer<'de>,
}

impl<'a, 'de> de::VariantAccess<'de> for DictVariantValue<'a, 'de> {
    type Error = Error;

    fn unit_variant(self) -> Result<(), Error> {
        Err(Error::Message("expected non-unit variant in dict".into()))
    }

    fn newtype_variant_seed<T: DeserializeSeed<'de>>(self, seed: T) -> Result<T::Value, Error> {
        let val = seed.deserialize(&mut *self.de)?;
        self.de.consume_end()?;
        Ok(val)
    }

    fn tuple_variant<V: Visitor<'de>>(self, _len: usize, visitor: V) -> Result<V::Value, Error> {
        if self.de.peek()? == b'l' {
            self.de.advance(1);
            let result = visitor.visit_seq(ListAccess { de: self.de })?;
            self.de.consume_end()?;
            // consume outer dict 'e'
            self.de.consume_end()?;
            Ok(result)
        } else {
            Err(Error::InvalidData("expected list for tuple variant".into()))
        }
    }

    fn struct_variant<V: Visitor<'de>>(self, _fields: &'static [&'static str], visitor: V) -> Result<V::Value, Error> {
        if self.de.peek()? == b'd' {
            self.de.advance(1);
            let result = visitor.visit_map(DictAccess { de: self.de })?;
            self.de.consume_end()?;
            // consume outer dict 'e'
            self.de.consume_end()?;
            Ok(result)
        } else {
            Err(Error::InvalidData("expected dict for struct variant".into()))
        }
    }
}
