use rand::{SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde::{Deserialize, Serialize,Serializer,Deserializer};

pub struct ChaCha8SerializationWrapper (
    pub ChaCha8Rng
);

impl Serialize for ChaCha8SerializationWrapper {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        hex::encode(&self.0.get_seed()).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ChaCha8SerializationWrapper {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let st = String::deserialize(deserializer)?;
        let slice = hex::decode(&st).unwrap();

        let mut bytes: [u8; 32] = [0; 32];
        for (i, b) in slice.iter().enumerate() {
            bytes[i % 32] = *b;
        }
        Ok(ChaCha8SerializationWrapper(ChaCha8Rng::from_seed(bytes)))
    }
}