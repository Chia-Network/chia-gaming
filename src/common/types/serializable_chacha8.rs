use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub struct ChaCha8SerializationWrapper(pub ChaCha8Rng);

impl Serialize for ChaCha8SerializationWrapper {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_bytes(&self.0.get_seed())
    }
}

impl<'de> Deserialize<'de> for ChaCha8SerializationWrapper {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct SeedVisitor;

        impl<'de> serde::de::Visitor<'de> for SeedVisitor {
            type Value = ChaCha8SerializationWrapper;

            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                write!(f, "32 bytes for ChaCha8 seed")
            }

            fn visit_bytes<E: serde::de::Error>(self, v: &[u8]) -> Result<Self::Value, E> {
                let mut bytes = [0u8; 32];
                for (i, b) in v.iter().enumerate() {
                    bytes[i % 32] = *b;
                }
                Ok(ChaCha8SerializationWrapper(ChaCha8Rng::from_seed(bytes)))
            }
        }

        deserializer.deserialize_bytes(SeedVisitor)
    }
}
