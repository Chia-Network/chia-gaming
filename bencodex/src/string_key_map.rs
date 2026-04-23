/// Serde helper for maps with non-string keys.
///
/// Bencodex dict keys must be bytestrings or unicode strings. This module
/// serializes each map key through its Display impl and deserializes via
/// FromStr, storing as a unicode dict key.
///
/// Usage: `#[serde(with = "bencodex::string_key_map")]`
use std::collections::HashMap;
use std::fmt::Display;
use std::hash::Hash;
use std::marker::PhantomData;
use std::str::FromStr;

use serde::de::{self, Deserialize, Deserializer, MapAccess, Visitor};
use serde::ser::{Serialize, SerializeMap, Serializer};

pub fn serialize<K, V, S>(map: &HashMap<K, V>, serializer: S) -> Result<S::Ok, S::Error>
where
    K: Display + Serialize,
    V: Serialize,
    S: Serializer,
{
    let mut m = serializer.serialize_map(Some(map.len()))?;
    for (k, v) in map {
        m.serialize_entry(&k.to_string(), v)?;
    }
    m.end()
}

pub fn deserialize<'de, K, V, D>(deserializer: D) -> Result<HashMap<K, V>, D::Error>
where
    K: FromStr + Eq + Hash,
    K::Err: Display,
    V: Deserialize<'de>,
    D: Deserializer<'de>,
{
    struct StringKeyMapVisitor<K, V>(PhantomData<(K, V)>);

    impl<'de, K, V> Visitor<'de> for StringKeyMapVisitor<K, V>
    where
        K: FromStr + Eq + Hash,
        K::Err: Display,
        V: Deserialize<'de>,
    {
        type Value = HashMap<K, V>;

        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("a map with string-encoded keys")
        }

        fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
            let mut map = HashMap::with_capacity(access.size_hint().unwrap_or(0));
            while let Some((k_str, v)) = access.next_entry::<String, V>()? {
                let k = K::from_str(&k_str).map_err(de::Error::custom)?;
                map.insert(k, v);
            }
            Ok(map)
        }
    }

    deserializer.deserialize_map(StringKeyMapVisitor(PhantomData))
}
