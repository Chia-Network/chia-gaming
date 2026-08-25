use chia_protocol::Bytes;

pub mod dict_tree;

/// Loads the krunk dictionary from `krunkwords.txt`, embedded at compile time.
pub fn dictionary() -> Vec<Bytes> {
    include_str!("../clsp/krunkwords.txt")
        .lines()
        .filter(|l| l.len() == 5)
        .map(|w| Bytes::from(w.as_bytes().to_vec()))
        .collect()
}

#[cfg(test)]
pub mod tests;
