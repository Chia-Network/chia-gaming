use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;

/// Wrapper around ChaCha8Rng that is intentionally NOT serialized.
/// Callers must supply fresh entropy on restore (see
/// `create_serialized_game` which overwrites the RNG immediately).
pub struct ChaCha8SerializationWrapper(pub ChaCha8Rng);

impl Default for ChaCha8SerializationWrapper {
    fn default() -> Self {
        ChaCha8SerializationWrapper(ChaCha8Rng::from_seed([0u8; 32]))
    }
}
