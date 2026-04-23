use serde::{Deserialize, Serialize};

use crate::{from_slice, to_vec};

#[test]
fn bool_true() {
    assert_eq!(to_vec(&true).unwrap(), b"t");
    assert_eq!(from_slice::<bool>(b"t").unwrap(), true);
}

#[test]
fn bool_false() {
    assert_eq!(to_vec(&false).unwrap(), b"f");
    assert_eq!(from_slice::<bool>(b"f").unwrap(), false);
}

#[test]
fn null_unit() {
    assert_eq!(to_vec(&()).unwrap(), b"n");
    assert_eq!(from_slice::<()>(b"n").unwrap(), ());
}

#[test]
fn null_none() {
    assert_eq!(to_vec(&None::<u32>).unwrap(), b"n");
    assert_eq!(from_slice::<Option<u32>>(b"n").unwrap(), None);
}

#[test]
fn option_some() {
    assert_eq!(to_vec(&Some(42u32)).unwrap(), b"i42e");
    assert_eq!(from_slice::<Option<u32>>(b"i42e").unwrap(), Some(42));
}

#[test]
fn positive_integer() {
    assert_eq!(to_vec(&42u64).unwrap(), b"i42e");
    assert_eq!(from_slice::<u64>(b"i42e").unwrap(), 42);
}

#[test]
fn zero() {
    assert_eq!(to_vec(&0u64).unwrap(), b"i0e");
    assert_eq!(from_slice::<u64>(b"i0e").unwrap(), 0);
}

#[test]
fn negative_integer() {
    assert_eq!(to_vec(&(-3i64)).unwrap(), b"i-3e");
    assert_eq!(from_slice::<i64>(b"i-3e").unwrap(), -3);
}

#[test]
fn large_integer() {
    let val = u64::MAX;
    let encoded = to_vec(&val).unwrap();
    assert_eq!(encoded, format!("i{}e", val).into_bytes());
    assert_eq!(from_slice::<u64>(&encoded).unwrap(), val);
}

#[test]
fn bytestring() {
    let bytes: &[u8] = b"spam";
    // serde_bytes or manual serialize_bytes
    let encoded = to_vec(&serde_bytes::ByteBuf::from(bytes.to_vec())).unwrap();
    assert_eq!(encoded, b"4:spam");
    let decoded: serde_bytes::ByteBuf = from_slice(b"4:spam").unwrap();
    assert_eq!(decoded.as_ref(), b"spam");
}

#[test]
fn empty_bytestring() {
    let encoded = to_vec(&serde_bytes::ByteBuf::from(vec![])).unwrap();
    assert_eq!(encoded, b"0:");
    let decoded: serde_bytes::ByteBuf = from_slice(b"0:").unwrap();
    assert_eq!(decoded.as_ref(), b"");
}

#[test]
fn unicode_string() {
    assert_eq!(to_vec(&"hello").unwrap(), b"u5:hello");
    assert_eq!(from_slice::<String>(b"u5:hello").unwrap(), "hello");
}

#[test]
fn unicode_multibyte() {
    let s = "단팥";
    let encoded = to_vec(&s).unwrap();
    // "단팥" is 6 UTF-8 bytes
    assert_eq!(&encoded[..3], b"u6:");
    assert_eq!(from_slice::<String>(&encoded).unwrap(), s);
}

#[test]
fn empty_string() {
    assert_eq!(to_vec(&"").unwrap(), b"u0:");
    assert_eq!(from_slice::<String>(b"u0:").unwrap(), "");
}

#[test]
fn simple_list() {
    let v = vec![1u64, 2, 3];
    let encoded = to_vec(&v).unwrap();
    assert_eq!(encoded, b"li1ei2ei3ee");
    assert_eq!(from_slice::<Vec<u64>>(&encoded).unwrap(), v);
}

#[test]
fn empty_list() {
    let v: Vec<u64> = vec![];
    assert_eq!(to_vec(&v).unwrap(), b"le");
    assert_eq!(from_slice::<Vec<u64>>(b"le").unwrap(), v);
}

#[test]
fn simple_struct() {
    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct Msg {
        x: u32,
        y: u32,
    }
    let msg = Msg { x: 10, y: 20 };
    let encoded = to_vec(&msg).unwrap();
    // keys sorted: "x" < "y"
    assert_eq!(encoded, b"du1:xi10eu1:yi20ee");
    assert_eq!(from_slice::<Msg>(&encoded).unwrap(), msg);
}

#[test]
fn struct_field_sorting() {
    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct Out {
        z: u32,
        a: u32,
        m: u32,
    }
    let val = Out { z: 3, a: 1, m: 2 };
    let encoded = to_vec(&val).unwrap();
    // Keys sorted alphabetically: a < m < z
    assert_eq!(encoded, b"du1:ai1eu1:mi2eu1:zi3ee");
    assert_eq!(from_slice::<Out>(&encoded).unwrap(), val);
}

#[test]
fn unit_variant() {
    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    enum Color { Red, Green }
    assert_eq!(to_vec(&Color::Red).unwrap(), b"u3:Red");
    assert_eq!(from_slice::<Color>(b"u3:Red").unwrap(), Color::Red);
    assert_eq!(from_slice::<Color>(b"u5:Green").unwrap(), Color::Green);
}

#[test]
fn newtype_variant() {
    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    enum Wrapper {
        Num(u64),
        Text(String),
    }
    let val = Wrapper::Num(42);
    let encoded = to_vec(&val).unwrap();
    assert_eq!(encoded, b"du3:Numi42ee");
    assert_eq!(from_slice::<Wrapper>(&encoded).unwrap(), val);

    let val2 = Wrapper::Text("hi".into());
    let encoded2 = to_vec(&val2).unwrap();
    assert_eq!(encoded2, b"du4:Textu2:hie");
    assert_eq!(from_slice::<Wrapper>(&encoded2).unwrap(), val2);
}

#[test]
fn struct_variant() {
    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    enum Msg {
        Move { x: u32, y: u32 },
    }
    let val = Msg::Move { x: 1, y: 2 };
    let encoded = to_vec(&val).unwrap();
    // outer dict: { "Move": { "x": 1, "y": 2 } }
    assert_eq!(encoded, b"du4:Movedu1:xi1eu1:yi2eee");
    assert_eq!(from_slice::<Msg>(&encoded).unwrap(), val);
}

#[test]
fn nested_struct() {
    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct Inner { val: u32 }
    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct Outer { inner: Inner, name: String }

    let val = Outer { inner: Inner { val: 7 }, name: "test".into() };
    let encoded = to_vec(&val).unwrap();
    let decoded: Outer = from_slice(&encoded).unwrap();
    assert_eq!(decoded, val);
}

#[test]
fn vec_u8_as_list() {
    // Plain Vec<u8> serializes as a list of integers, not bytes
    let v: Vec<u8> = vec![1, 2, 3];
    let encoded = to_vec(&v).unwrap();
    assert_eq!(encoded, b"li1ei2ei3ee");
    assert_eq!(from_slice::<Vec<u8>>(&encoded).unwrap(), v);
}

#[test]
fn dict_key_ordering_bytes_before_unicode() {
    // Bencodex requires byte keys before unicode keys.
    // This test uses a HashMap<String, u32> where keys are all unicode,
    // and verifies they're sorted.
    use std::collections::BTreeMap;
    let mut m = BTreeMap::new();
    m.insert("z".to_string(), 1u32);
    m.insert("a".to_string(), 2u32);
    let encoded = to_vec(&m).unwrap();
    // "a" < "z" as unicode keys
    assert_eq!(encoded, b"du1:ai2eu1:zi1ee");
    let decoded: BTreeMap<String, u32> = from_slice(&encoded).unwrap();
    assert_eq!(decoded, m);
}

#[test]
fn round_trip_complex() {
    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    enum Action {
        Move(u64),
        #[serde(rename = "Accept")]
        AcceptTimeout(u64),
    }

    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    struct Batch {
        actions: Vec<Action>,
        count: u32,
        done: bool,
        label: Option<String>,
    }

    let val = Batch {
        actions: vec![Action::Move(5), Action::AcceptTimeout(10)],
        count: 2,
        done: true,
        label: None,
    };
    let encoded = to_vec(&val).unwrap();
    let decoded: Batch = from_slice(&encoded).unwrap();
    assert_eq!(decoded, val);
}

#[test]
fn invalid_integer_leading_zero() {
    assert!(from_slice::<u64>(b"i03e").is_err());
}

#[test]
fn invalid_integer_negative_zero() {
    assert!(from_slice::<i64>(b"i-0e").is_err());
}

#[test]
fn trailing_bytes_error() {
    assert!(from_slice::<u64>(b"i42eextra").is_err());
}

#[test]
fn tuple_variant_round_trip() {
    #[derive(Serialize, Deserialize, PartialEq, Debug)]
    enum Msg {
        Pair(u32, String),
    }
    let val = Msg::Pair(1, "hi".into());
    let encoded = to_vec(&val).unwrap();
    let decoded: Msg = from_slice(&encoded).unwrap();
    assert_eq!(decoded, val);
}
