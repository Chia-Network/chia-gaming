//! Pretty-printer for the protocol-level peer state.
//!
//! The cradle's `peer` (`Box<dyn PeerLifecyclePhase>`) is serialized to bencodex via
//! typetag, then re-read into an untyped [`BencodexValue`] tree and rendered as
//! indented text for the dashboard. Working from the serialized tree (rather
//! than the typed structs) keeps the renderer decoupled from the concrete
//! handler types and automatically reflects the polymorphic phase as the
//! top-level type tag.
//!
//! Elision rules keep the output readable without leaking secrets:
//! - Byte strings longer than [`ELIDE_BYTES_OVER`] are summarized by length.
//!   This drops aggsigs and puzzle reveals while keeping coin ids, hashes, and
//!   public keys visible as hex.
//! - `private_keys` is redacted by name; `game_types` is elided by name; and
//!   buffered message queues are reduced to a count.

use std::fmt;

use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};

/// Byte strings longer than this are elided. 80 keeps coin ids (~72 bytes),
/// 32-byte hashes, and 48-byte public keys visible while dropping aggsigs
/// (~96 bytes) and larger puzzle reveals.
const ELIDE_BYTES_OVER: usize = 80;

/// An untyped bencodex value. Map entries are stored as an ordered list of
/// pairs because bencodex keys may be byte strings, not just text.
#[derive(Debug)]
pub enum BencodexValue {
    Null,
    Bool(bool),
    Int(i128),
    Bytes(Vec<u8>),
    Text(String),
    List(Vec<BencodexValue>),
    Map(Vec<(BencodexValue, BencodexValue)>),
}

impl<'de> Deserialize<'de> for BencodexValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ValueVisitor;

        impl<'de> Visitor<'de> for ValueVisitor {
            type Value = BencodexValue;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("any bencodex value")
            }

            fn visit_bool<E>(self, v: bool) -> Result<Self::Value, E> {
                Ok(BencodexValue::Bool(v))
            }
            fn visit_i64<E>(self, v: i64) -> Result<Self::Value, E> {
                Ok(BencodexValue::Int(v as i128))
            }
            fn visit_i128<E>(self, v: i128) -> Result<Self::Value, E> {
                Ok(BencodexValue::Int(v))
            }
            fn visit_u64<E>(self, v: u64) -> Result<Self::Value, E> {
                Ok(BencodexValue::Int(v as i128))
            }
            fn visit_u128<E>(self, v: u128) -> Result<Self::Value, E> {
                Ok(BencodexValue::Int(v as i128))
            }
            fn visit_str<E>(self, v: &str) -> Result<Self::Value, E> {
                Ok(BencodexValue::Text(v.to_string()))
            }
            fn visit_string<E>(self, v: String) -> Result<Self::Value, E> {
                Ok(BencodexValue::Text(v))
            }
            fn visit_bytes<E>(self, v: &[u8]) -> Result<Self::Value, E> {
                Ok(BencodexValue::Bytes(v.to_vec()))
            }
            fn visit_byte_buf<E>(self, v: Vec<u8>) -> Result<Self::Value, E> {
                Ok(BencodexValue::Bytes(v))
            }
            fn visit_unit<E>(self) -> Result<Self::Value, E> {
                Ok(BencodexValue::Null)
            }
            fn visit_none<E>(self) -> Result<Self::Value, E> {
                Ok(BencodexValue::Null)
            }
            fn visit_some<D: Deserializer<'de>>(
                self,
                deserializer: D,
            ) -> Result<Self::Value, D::Error> {
                BencodexValue::deserialize(deserializer)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(BencodexValue::List(items))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut entries = Vec::new();
                while let Some((k, v)) = map.next_entry()? {
                    entries.push((k, v));
                }
                Ok(BencodexValue::Map(entries))
            }
        }

        deserializer.deserialize_any(ValueVisitor)
    }
}

fn push_indent(out: &mut String, indent: usize) {
    for _ in 0..indent {
        out.push_str("  ");
    }
}

fn key_to_string(key: &BencodexValue) -> String {
    match key {
        BencodexValue::Text(s) => s.clone(),
        BencodexValue::Bytes(b) => format!("0x{}", hex::encode(b)),
        BencodexValue::Int(i) => i.to_string(),
        BencodexValue::Bool(b) => b.to_string(),
        BencodexValue::Null => "null".to_string(),
        _ => "<key>".to_string(),
    }
}

/// Render a byte string as hex, eliding by length.
fn bytes_repr(b: &[u8]) -> String {
    if b.len() > ELIDE_BYTES_OVER {
        format!("<elided {} bytes>", b.len())
    } else {
        format!("0x{}", hex::encode(b))
    }
}

/// Inline rendering for leaf values. Returns `None` for lists and maps, which
/// must be rendered as indented blocks instead.
fn scalar_repr(value: &BencodexValue) -> Option<String> {
    match value {
        BencodexValue::Null => Some("null".to_string()),
        BencodexValue::Bool(b) => Some(b.to_string()),
        BencodexValue::Int(i) => Some(i.to_string()),
        BencodexValue::Text(s) => Some(format!("\"{s}\"")),
        BencodexValue::Bytes(b) => Some(bytes_repr(b)),
        BencodexValue::List(_) | BencodexValue::Map(_) => None,
    }
}

/// Map entries whose key matches are omitted entirely: secrets, plus huge or
/// uninformative structures (the unroll puzzle-hash map and the cached
/// last-action log grow with session length and aren't useful in a state dump).
fn should_skip_key(key: &str) -> bool {
    matches!(
        key,
        "private_keys" | "game_types" | "unroll_puzzle_hash_map" | "cached_redo_actions"
    )
}

/// Buffered message queues are summarized by count rather than dumped.
fn buffer_count(key: &str, value: &BencodexValue) -> Option<String> {
    match key {
        "incoming_messages" | "inbound_messages" | "game_action_queue" => {
            let count = match value {
                BencodexValue::List(items) => items.len(),
                BencodexValue::Map(entries) => entries.len(),
                BencodexValue::Null => 0,
                _ => 1,
            };
            Some(format!("<{count} buffered>"))
        }
        _ => None,
    }
}

/// Render a map entry's `value` after the caller has emitted `key:` (without a
/// trailing newline). Scalars are inlined; nested collections start on the next
/// line, indented one level deeper than `indent`.
fn write_keyed_value(out: &mut String, indent: usize, key: &str, value: &BencodexValue) {
    if let Some(summary) = buffer_count(key, value) {
        out.push(' ');
        out.push_str(&summary);
        out.push('\n');
    } else {
        write_value(out, indent, value);
    }
}

fn write_value(out: &mut String, indent: usize, value: &BencodexValue) {
    match value {
        BencodexValue::Map(entries) if !entries.is_empty() => {
            out.push('\n');
            for (k, v) in entries {
                let key = key_to_string(k);
                if should_skip_key(&key) {
                    continue;
                }
                push_indent(out, indent + 1);
                out.push_str(&key);
                out.push(':');
                write_keyed_value(out, indent + 1, &key, v);
            }
        }
        BencodexValue::List(items) if !items.is_empty() => {
            out.push('\n');
            for item in items {
                push_indent(out, indent + 1);
                out.push('-');
                write_value(out, indent + 1, item);
            }
        }
        BencodexValue::Map(_) => {
            out.push_str(" {}\n");
        }
        BencodexValue::List(_) => {
            out.push_str(" []\n");
        }
        scalar => {
            out.push(' ');
            out.push_str(&scalar_repr(scalar).unwrap_or_default());
            out.push('\n');
        }
    }
}

/// Render a [`BencodexValue`] tree as indented text. The top level is usually
/// the typetag map (`{ "OffChainPhase": { ... } }`), so the concrete handler
/// type appears as the first line.
pub fn pretty_print(value: &BencodexValue) -> String {
    let mut out = String::new();
    match value {
        BencodexValue::Map(entries) if !entries.is_empty() => {
            for (k, v) in entries {
                let key = key_to_string(k);
                if should_skip_key(&key) {
                    continue;
                }
                out.push_str(&key);
                out.push(':');
                write_keyed_value(&mut out, 0, &key, v);
            }
        }
        other => {
            if let Some(s) = scalar_repr(other) {
                out.push_str(&s);
                out.push('\n');
            } else {
                write_value(&mut out, 0, other);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(s: &str) -> BencodexValue {
        BencodexValue::Text(s.to_string())
    }

    #[test]
    fn renders_nested_map_with_elision_and_redaction() {
        // Mimics the typetag shape: { "OffChainPhase": { ...fields... } }.
        let inner = BencodexValue::Map(vec![
            (text("have_potato"), BencodexValue::Bool(true)),
            (text("state_number"), BencodexValue::Int(7)),
            // 32-byte coin-id-ish blob is kept as hex.
            (text("coin"), BencodexValue::Bytes(vec![0xab; 32])),
            // A Vec<u8> field now arrives as a byte string and renders as hex.
            (
                text("move_made"),
                BencodexValue::Bytes(vec![0xde, 0xad, 0xbe, 0xef]),
            ),
            // Over-threshold blob (aggsig-ish) is elided by length.
            (text("aggsig"), BencodexValue::Bytes(vec![0x11; 96])),
            // Secrets and huge/uninformative structures are skipped entirely.
            (text("private_keys"), BencodexValue::Bytes(vec![0x22; 32])),
            (
                text("game_types"),
                BencodexValue::List(vec![text("calpoker")]),
            ),
            (
                text("unroll_puzzle_hash_map"),
                BencodexValue::Map(vec![(text("k"), text("v"))]),
            ),
            (
                text("cached_redo_actions"),
                BencodexValue::List(vec![text("a"), text("b")]),
            ),
            (
                text("incoming_messages"),
                BencodexValue::List(vec![text("a"), text("b")]),
            ),
        ]);
        let root = BencodexValue::Map(vec![(text("OffChainPhase"), inner)]);

        let rendered = pretty_print(&root);
        let expected = "\
OffChainPhase:
  have_potato: true
  state_number: 7
  coin: 0xabababababababababababababababababababababababababababababababab
  move_made: 0xdeadbeef
  aggsig: <elided 96 bytes>
  incoming_messages: <2 buffered>
";
        assert_eq!(rendered, expected);
    }
}
