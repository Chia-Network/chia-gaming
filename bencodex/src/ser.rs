use serde::ser::{self, Serialize};

use crate::Error;

pub fn to_vec<T: Serialize>(value: &T) -> Result<Vec<u8>, Error> {
    let mut ser = BencodexSerializer { out: Vec::new() };
    value.serialize(&mut ser)?;
    Ok(ser.out)
}

pub(crate) struct BencodexSerializer {
    out: Vec<u8>,
}

fn write_bytestring(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(bytes.len().to_string().as_bytes());
    out.push(b':');
    out.extend_from_slice(bytes);
}

fn write_unicode(out: &mut Vec<u8>, s: &str) {
    let utf8 = s.as_bytes();
    out.push(b'u');
    out.extend_from_slice(utf8.len().to_string().as_bytes());
    out.push(b':');
    out.extend_from_slice(utf8);
}

fn write_int(out: &mut Vec<u8>, v: i128) {
    out.push(b'i');
    out.extend_from_slice(v.to_string().as_bytes());
    out.push(b'e');
}

impl<'a> ser::Serializer for &'a mut BencodexSerializer {
    type Ok = ();
    type Error = Error;
    type SerializeSeq = SeqSerializer<'a>;
    type SerializeTuple = SeqSerializer<'a>;
    type SerializeTupleStruct = SeqSerializer<'a>;
    type SerializeTupleVariant = TupleVariantSerializer<'a>;
    type SerializeMap = DictCollector<'a>;
    type SerializeStruct = DictCollector<'a>;
    type SerializeStructVariant = StructVariantCollector<'a>;

    fn serialize_bool(self, v: bool) -> Result<(), Error> {
        self.out.push(if v { b't' } else { b'f' });
        Ok(())
    }

    fn serialize_i8(self, v: i8) -> Result<(), Error> { write_int(&mut self.out, v as i128); Ok(()) }
    fn serialize_i16(self, v: i16) -> Result<(), Error> { write_int(&mut self.out, v as i128); Ok(()) }
    fn serialize_i32(self, v: i32) -> Result<(), Error> { write_int(&mut self.out, v as i128); Ok(()) }
    fn serialize_i64(self, v: i64) -> Result<(), Error> { write_int(&mut self.out, v as i128); Ok(()) }
    fn serialize_i128(self, v: i128) -> Result<(), Error> { write_int(&mut self.out, v); Ok(()) }
    fn serialize_u8(self, v: u8) -> Result<(), Error> { write_int(&mut self.out, v as i128); Ok(()) }
    fn serialize_u16(self, v: u16) -> Result<(), Error> { write_int(&mut self.out, v as i128); Ok(()) }
    fn serialize_u32(self, v: u32) -> Result<(), Error> { write_int(&mut self.out, v as i128); Ok(()) }
    fn serialize_u64(self, v: u64) -> Result<(), Error> { write_int(&mut self.out, v as i128); Ok(()) }
    fn serialize_u128(self, v: u128) -> Result<(), Error> { write_int(&mut self.out, v as i128); Ok(()) }

    fn serialize_f32(self, _v: f32) -> Result<(), Error> {
        Err(Error::Message("bencodex does not support floats".into()))
    }
    fn serialize_f64(self, _v: f64) -> Result<(), Error> {
        Err(Error::Message("bencodex does not support floats".into()))
    }

    fn serialize_char(self, v: char) -> Result<(), Error> {
        let mut buf = [0u8; 4];
        write_unicode(&mut self.out, v.encode_utf8(&mut buf));
        Ok(())
    }

    fn serialize_str(self, v: &str) -> Result<(), Error> {
        write_unicode(&mut self.out, v);
        Ok(())
    }

    fn serialize_bytes(self, v: &[u8]) -> Result<(), Error> {
        write_bytestring(&mut self.out, v);
        Ok(())
    }

    fn serialize_none(self) -> Result<(), Error> { self.out.push(b'n'); Ok(()) }
    fn serialize_some<T: ?Sized + Serialize>(self, value: &T) -> Result<(), Error> { value.serialize(self) }
    fn serialize_unit(self) -> Result<(), Error> { self.out.push(b'n'); Ok(()) }
    fn serialize_unit_struct(self, _name: &'static str) -> Result<(), Error> { self.out.push(b'n'); Ok(()) }

    fn serialize_unit_variant(self, _name: &'static str, _idx: u32, variant: &'static str) -> Result<(), Error> {
        write_unicode(&mut self.out, variant);
        Ok(())
    }

    fn serialize_newtype_struct<T: ?Sized + Serialize>(self, _name: &'static str, value: &T) -> Result<(), Error> {
        value.serialize(self)
    }

    fn serialize_newtype_variant<T: ?Sized + Serialize>(
        self, _name: &'static str, _idx: u32, variant: &'static str, value: &T,
    ) -> Result<(), Error> {
        self.out.push(b'd');
        write_unicode(&mut self.out, variant);
        value.serialize(&mut *self)?;
        self.out.push(b'e');
        Ok(())
    }

    fn serialize_seq(self, _len: Option<usize>) -> Result<SeqSerializer<'a>, Error> {
        self.out.push(b'l');
        Ok(SeqSerializer { ser: self })
    }

    fn serialize_tuple(self, _len: usize) -> Result<SeqSerializer<'a>, Error> {
        self.out.push(b'l');
        Ok(SeqSerializer { ser: self })
    }

    fn serialize_tuple_struct(self, _name: &'static str, _len: usize) -> Result<SeqSerializer<'a>, Error> {
        self.out.push(b'l');
        Ok(SeqSerializer { ser: self })
    }

    fn serialize_tuple_variant(
        self, _name: &'static str, _idx: u32, variant: &'static str, _len: usize,
    ) -> Result<TupleVariantSerializer<'a>, Error> {
        self.out.push(b'd');
        write_unicode(&mut self.out, variant);
        self.out.push(b'l');
        Ok(TupleVariantSerializer { ser: self })
    }

    fn serialize_map(self, _len: Option<usize>) -> Result<DictCollector<'a>, Error> {
        Ok(DictCollector { ser: self, entries: Vec::new(), current_key: None })
    }

    fn serialize_struct(self, _name: &'static str, _len: usize) -> Result<DictCollector<'a>, Error> {
        Ok(DictCollector { ser: self, entries: Vec::new(), current_key: None })
    }

    fn serialize_struct_variant(
        self, _name: &'static str, _idx: u32, variant: &'static str, _len: usize,
    ) -> Result<StructVariantCollector<'a>, Error> {
        Ok(StructVariantCollector { ser: self, variant, entries: Vec::new() })
    }
}

// --- Sequence ---

pub(crate) struct SeqSerializer<'a> {
    ser: &'a mut BencodexSerializer,
}

impl ser::SerializeSeq for SeqSerializer<'_> {
    type Ok = ();
    type Error = Error;
    fn serialize_element<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Error> {
        value.serialize(&mut *self.ser)
    }
    fn end(self) -> Result<(), Error> { self.ser.out.push(b'e'); Ok(()) }
}

impl ser::SerializeTuple for SeqSerializer<'_> {
    type Ok = ();
    type Error = Error;
    fn serialize_element<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Error> {
        value.serialize(&mut *self.ser)
    }
    fn end(self) -> Result<(), Error> { self.ser.out.push(b'e'); Ok(()) }
}

impl ser::SerializeTupleStruct for SeqSerializer<'_> {
    type Ok = ();
    type Error = Error;
    fn serialize_field<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Error> {
        value.serialize(&mut *self.ser)
    }
    fn end(self) -> Result<(), Error> { self.ser.out.push(b'e'); Ok(()) }
}

// --- Tuple variant ---

pub(crate) struct TupleVariantSerializer<'a> {
    ser: &'a mut BencodexSerializer,
}

impl ser::SerializeTupleVariant for TupleVariantSerializer<'_> {
    type Ok = ();
    type Error = Error;
    fn serialize_field<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Error> {
        value.serialize(&mut *self.ser)
    }
    fn end(self) -> Result<(), Error> {
        self.ser.out.push(b'e'); // close list
        self.ser.out.push(b'e'); // close dict
        Ok(())
    }
}

// --- Dict key type and sorting ---

#[derive(Clone, PartialEq, Eq)]
enum DictKey {
    Bytes(Vec<u8>),
    Unicode(Vec<u8>),
}

impl DictKey {
    fn write_to(&self, out: &mut Vec<u8>) {
        match self {
            DictKey::Bytes(b) => write_bytestring(out, b),
            DictKey::Unicode(b) => {
                out.push(b'u');
                out.extend_from_slice(b.len().to_string().as_bytes());
                out.push(b':');
                out.extend_from_slice(b);
            }
        }
    }
}

impl Ord for DictKey {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        match (self, other) {
            (DictKey::Bytes(a), DictKey::Bytes(b)) => a.cmp(b),
            (DictKey::Unicode(a), DictKey::Unicode(b)) => a.cmp(b),
            (DictKey::Bytes(_), DictKey::Unicode(_)) => std::cmp::Ordering::Less,
            (DictKey::Unicode(_), DictKey::Bytes(_)) => std::cmp::Ordering::Greater,
        }
    }
}

impl PartialOrd for DictKey {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

// --- Key capture ---

struct KeyCapture(Option<DictKey>);

impl ser::Serializer for &mut KeyCapture {
    type Ok = ();
    type Error = Error;
    type SerializeSeq = ser::Impossible<(), Error>;
    type SerializeTuple = ser::Impossible<(), Error>;
    type SerializeTupleStruct = ser::Impossible<(), Error>;
    type SerializeTupleVariant = ser::Impossible<(), Error>;
    type SerializeMap = ser::Impossible<(), Error>;
    type SerializeStruct = ser::Impossible<(), Error>;
    type SerializeStructVariant = ser::Impossible<(), Error>;

    fn serialize_str(self, v: &str) -> Result<(), Error> { self.0 = Some(DictKey::Unicode(v.as_bytes().to_vec())); Ok(()) }
    fn serialize_bytes(self, v: &[u8]) -> Result<(), Error> { self.0 = Some(DictKey::Bytes(v.to_vec())); Ok(()) }
    fn serialize_u8(self, v: u8) -> Result<(), Error> { self.0 = Some(DictKey::Bytes(vec![v])); Ok(()) }
    fn serialize_u16(self, v: u16) -> Result<(), Error> { self.0 = Some(DictKey::Unicode(v.to_string().into_bytes())); Ok(()) }
    fn serialize_u32(self, v: u32) -> Result<(), Error> { self.0 = Some(DictKey::Unicode(v.to_string().into_bytes())); Ok(()) }
    fn serialize_u64(self, v: u64) -> Result<(), Error> { self.0 = Some(DictKey::Unicode(v.to_string().into_bytes())); Ok(()) }
    fn serialize_i8(self, v: i8) -> Result<(), Error> { self.0 = Some(DictKey::Unicode(v.to_string().into_bytes())); Ok(()) }
    fn serialize_i16(self, v: i16) -> Result<(), Error> { self.0 = Some(DictKey::Unicode(v.to_string().into_bytes())); Ok(()) }
    fn serialize_i32(self, v: i32) -> Result<(), Error> { self.0 = Some(DictKey::Unicode(v.to_string().into_bytes())); Ok(()) }
    fn serialize_i64(self, v: i64) -> Result<(), Error> { self.0 = Some(DictKey::Unicode(v.to_string().into_bytes())); Ok(()) }
    fn serialize_bool(self, _: bool) -> Result<(), Error> { Err(Error::Message("bool cannot be a dict key".into())) }
    fn serialize_f32(self, _: f32) -> Result<(), Error> { Err(Error::Message("float cannot be a dict key".into())) }
    fn serialize_f64(self, _: f64) -> Result<(), Error> { Err(Error::Message("float cannot be a dict key".into())) }
    fn serialize_char(self, v: char) -> Result<(), Error> {
        let mut buf = [0u8; 4];
        self.0 = Some(DictKey::Unicode(v.encode_utf8(&mut buf).as_bytes().to_vec())); Ok(())
    }
    fn serialize_none(self) -> Result<(), Error> { Err(Error::Message("none cannot be a dict key".into())) }
    fn serialize_some<T: ?Sized + Serialize>(self, value: &T) -> Result<(), Error> { value.serialize(self) }
    fn serialize_unit(self) -> Result<(), Error> { Err(Error::Message("unit cannot be a dict key".into())) }
    fn serialize_unit_struct(self, _: &'static str) -> Result<(), Error> { Err(Error::Message("unit struct cannot be a dict key".into())) }
    fn serialize_unit_variant(self, _: &'static str, _: u32, v: &'static str) -> Result<(), Error> {
        self.0 = Some(DictKey::Unicode(v.as_bytes().to_vec())); Ok(())
    }
    fn serialize_newtype_struct<T: ?Sized + Serialize>(self, _: &'static str, value: &T) -> Result<(), Error> { value.serialize(self) }
    fn serialize_newtype_variant<T: ?Sized + Serialize>(self, _: &'static str, _: u32, _: &'static str, _: &T) -> Result<(), Error> {
        Err(Error::Message("newtype variant cannot be a dict key".into()))
    }
    fn serialize_seq(self, _: Option<usize>) -> Result<Self::SerializeSeq, Error> { Err(Error::Message("seq cannot be a dict key".into())) }
    fn serialize_tuple(self, _: usize) -> Result<Self::SerializeTuple, Error> { Err(Error::Message("tuple cannot be a dict key".into())) }
    fn serialize_tuple_struct(self, _: &'static str, _: usize) -> Result<Self::SerializeTupleStruct, Error> { Err(Error::Message("tuple struct cannot be a dict key".into())) }
    fn serialize_tuple_variant(self, _: &'static str, _: u32, _: &'static str, _: usize) -> Result<Self::SerializeTupleVariant, Error> { Err(Error::Message("tuple variant cannot be a dict key".into())) }
    fn serialize_map(self, _: Option<usize>) -> Result<Self::SerializeMap, Error> { Err(Error::Message("map cannot be a dict key".into())) }
    fn serialize_struct(self, _: &'static str, _: usize) -> Result<Self::SerializeStruct, Error> { Err(Error::Message("struct cannot be a dict key".into())) }
    fn serialize_struct_variant(self, _: &'static str, _: u32, _: &'static str, _: usize) -> Result<Self::SerializeStructVariant, Error> { Err(Error::Message("struct variant cannot be a dict key".into())) }
}

// --- Dict collector ---

pub(crate) struct DictCollector<'a> {
    ser: &'a mut BencodexSerializer,
    entries: Vec<(DictKey, Vec<u8>)>,
    current_key: Option<DictKey>,
}

impl DictCollector<'_> {
    fn flush(mut self) {
        self.entries.sort_by(|(a, _), (b, _)| a.cmp(b));
        self.ser.out.push(b'd');
        for (key, value) in &self.entries {
            key.write_to(&mut self.ser.out);
            self.ser.out.extend_from_slice(value);
        }
        self.ser.out.push(b'e');
    }
}

impl ser::SerializeMap for DictCollector<'_> {
    type Ok = ();
    type Error = Error;

    fn serialize_key<T: ?Sized + Serialize>(&mut self, key: &T) -> Result<(), Error> {
        let mut cap = KeyCapture(None);
        key.serialize(&mut cap)?;
        self.current_key = cap.0;
        Ok(())
    }

    fn serialize_value<T: ?Sized + Serialize>(&mut self, value: &T) -> Result<(), Error> {
        let key = self.current_key.take()
            .ok_or_else(|| Error::Message("value without key".into()))?;
        let mut sub = BencodexSerializer { out: Vec::new() };
        value.serialize(&mut sub)?;
        self.entries.push((key, sub.out));
        Ok(())
    }

    fn end(self) -> Result<(), Error> { self.flush(); Ok(()) }
}

impl ser::SerializeStruct for DictCollector<'_> {
    type Ok = ();
    type Error = Error;

    fn serialize_field<T: ?Sized + Serialize>(&mut self, key: &'static str, value: &T) -> Result<(), Error> {
        let dict_key = DictKey::Unicode(key.as_bytes().to_vec());
        let mut sub = BencodexSerializer { out: Vec::new() };
        value.serialize(&mut sub)?;
        self.entries.push((dict_key, sub.out));
        Ok(())
    }

    fn end(self) -> Result<(), Error> { self.flush(); Ok(()) }
}

// --- Struct variant collector ---

pub(crate) struct StructVariantCollector<'a> {
    ser: &'a mut BencodexSerializer,
    variant: &'static str,
    entries: Vec<(DictKey, Vec<u8>)>,
}

impl ser::SerializeStructVariant for StructVariantCollector<'_> {
    type Ok = ();
    type Error = Error;

    fn serialize_field<T: ?Sized + Serialize>(&mut self, key: &'static str, value: &T) -> Result<(), Error> {
        let dict_key = DictKey::Unicode(key.as_bytes().to_vec());
        let mut sub = BencodexSerializer { out: Vec::new() };
        value.serialize(&mut sub)?;
        self.entries.push((dict_key, sub.out));
        Ok(())
    }

    fn end(mut self) -> Result<(), Error> {
        self.entries.sort_by(|(a, _), (b, _)| a.cmp(b));
        self.ser.out.push(b'd');
        write_unicode(&mut self.ser.out, self.variant);
        self.ser.out.push(b'd');
        for (key, value) in &self.entries {
            key.write_to(&mut self.ser.out);
            self.ser.out.extend_from_slice(value);
        }
        self.ser.out.push(b'e'); // inner dict
        self.ser.out.push(b'e'); // outer dict
        Ok(())
    }
}
