use std::collections::BTreeSet;

use clvmr::{Allocator, NodePtr, SExp};

pub struct FactoryGameRecord {
    pub proposer_contribution: u64,
    pub accepter_contribution: u64,
    pub amount: u64,
    pub proposer_goes_first: bool,
    pub initial_move: Vec<u8>,
    pub initial_max_move_size: u32,
    pub initial_state: NodePtr,
    pub initial_mover_share: u64,
    pub my_turn_handler: NodePtr,
    pub their_turn_handler: NodePtr,
    pub validation_programs: Vec<NodePtr>,
    pub readable_parameters: NodePtr,
}

pub enum FactoryResultNodes {
    Success(Vec<FactoryGameRecord>),
    InsufficientBalance {
        proposer_balance_short: bool,
        accepter_balance_short: bool,
    },
}

fn proper_list(allocator: &Allocator, mut node: NodePtr) -> Option<Vec<NodePtr>> {
    let mut items = Vec::new();
    loop {
        match allocator.sexp(node) {
            SExp::Pair(first, rest) => {
                items.push(first);
                node = rest;
            }
            SExp::Atom if allocator.atom(node).is_empty() => return Some(items),
            SExp::Atom => return None,
        }
    }
}

fn canonical_boolean(
    allocator: &Allocator,
    node: NodePtr,
    context: &str,
    field: &str,
) -> Result<bool, String> {
    match allocator.sexp(node) {
        SExp::Atom => match allocator.atom(node).as_ref() {
            [] => Ok(false),
            [1] => Ok(true),
            _ => Err(format!("{context} {field} is not canonical boolean")),
        },
        SExp::Pair(_, _) => Err(format!("{context} {field} is not an atom")),
    }
}

fn atom(
    allocator: &Allocator,
    node: NodePtr,
    context: &str,
    field: &str,
) -> Result<Vec<u8>, String> {
    match allocator.sexp(node) {
        SExp::Atom => Ok(allocator.atom(node).as_ref().to_vec()),
        SExp::Pair(_, _) => Err(format!("{context} {field} is not an atom")),
    }
}

fn unsigned_u64(
    allocator: &Allocator,
    node: NodePtr,
    context: &str,
    field: &str,
) -> Result<u64, String> {
    let bytes = atom(allocator, node, context, field)?;
    if bytes.first().is_some_and(|byte| byte & 0x80 != 0) {
        return Err(format!("{context} {field} is negative"));
    }
    bytes.iter().try_fold(0u64, |value, byte| {
        value
            .checked_mul(256)
            .and_then(|value| value.checked_add(u64::from(*byte)))
            .ok_or_else(|| format!("{context} {field} exceeds u64"))
    })
}

pub fn parse_factory_result(
    allocator: &Allocator,
    result: NodePtr,
    context: &str,
) -> Result<FactoryResultNodes, String> {
    let envelope = proper_list(allocator, result)
        .ok_or_else(|| format!("{context} did not return a proper result"))?;
    let tag = envelope
        .first()
        .copied()
        .ok_or_else(|| format!("{context} result is empty"))?;
    let success = canonical_boolean(allocator, tag, context, "result tag")?;

    if !success {
        if envelope.len() != 3 {
            return Err(format!("{context} insufficient result must have 3 fields"));
        }
        return Ok(FactoryResultNodes::InsufficientBalance {
            proposer_balance_short: canonical_boolean(
                allocator,
                envelope[1],
                context,
                "proposer shortage flag",
            )?,
            accepter_balance_short: canonical_boolean(
                allocator,
                envelope[2],
                context,
                "accepter shortage flag",
            )?,
        });
    }

    if envelope.len() != 2 {
        return Err(format!("{context} success result must be (1 records)"));
    }
    let records = proper_list(allocator, envelope[1])
        .ok_or_else(|| format!("{context} games are not a proper list"))?;
    if records.is_empty() {
        return Err(format!("{context} returned no games"));
    }

    let mut parsed = Vec::with_capacity(records.len());
    for (record_index, record) in records.into_iter().enumerate() {
        let record_context = format!("{context} game {record_index}");
        let fields = proper_list(allocator, record)
            .ok_or_else(|| format!("{record_context} is not a proper list"))?;
        let fields: [NodePtr; 11] = fields.try_into().map_err(|fields: Vec<NodePtr>| {
            format!("{record_context} has {} fields, expected 11", fields.len())
        })?;
        let proposer_contribution = unsigned_u64(
            allocator,
            fields[0],
            &record_context,
            "proposer_contribution",
        )?;
        let accepter_contribution = unsigned_u64(
            allocator,
            fields[1],
            &record_context,
            "accepter_contribution",
        )?;
        let amount = proposer_contribution
            .checked_add(accepter_contribution)
            .ok_or_else(|| format!("{record_context} contributions exceed u64"))?;
        let proposer_goes_first =
            canonical_boolean(allocator, fields[2], &record_context, "proposer_goes_first")?;
        let initial_move = atom(allocator, fields[3], &record_context, "initial_move")?;
        let initial_max_move_size = unsigned_u64(
            allocator,
            fields[4],
            &record_context,
            "initial_max_move_size",
        )
        .and_then(|value| {
            u32::try_from(value)
                .map_err(|_| format!("{record_context} initial_max_move_size exceeds u32"))
        })?;
        let initial_mover_share =
            unsigned_u64(allocator, fields[6], &record_context, "initial_mover_share")?;
        if initial_mover_share > amount {
            return Err(format!(
                "{record_context} initial_mover_share {initial_mover_share} exceeds amount {amount}"
            ));
        }
        let validation_programs = proper_list(allocator, fields[9])
            .ok_or_else(|| format!("{record_context} validation programs are not a proper list"))?;
        if validation_programs.is_empty() {
            return Err(format!("{record_context} returned no validation programs"));
        }
        let mut hashes = BTreeSet::new();
        for (validator_index, validator) in validation_programs.iter().enumerate() {
            if matches!(allocator.sexp(*validator), SExp::Atom)
                && allocator.atom(*validator).is_empty()
            {
                return Err(format!(
                    "{record_context} validation program {validator_index} is nil"
                ));
            }
            let hash = clvm_utils::tree_hash(allocator, *validator).to_bytes();
            if !hashes.insert(hash) {
                return Err(format!(
                    "{record_context} validation program {validator_index} is duplicated"
                ));
            }
        }
        parsed.push(FactoryGameRecord {
            proposer_contribution,
            accepter_contribution,
            amount,
            proposer_goes_first,
            initial_move,
            initial_max_move_size,
            initial_state: fields[5],
            initial_mover_share,
            my_turn_handler: fields[7],
            their_turn_handler: fields[8],
            validation_programs,
            readable_parameters: fields[10],
        });
    }

    Ok(FactoryResultNodes::Success(parsed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn atom(allocator: &mut Allocator, value: u8) -> NodePtr {
        allocator.new_atom(&[value]).unwrap()
    }

    fn list(allocator: &mut Allocator, nodes: &[NodePtr]) -> NodePtr {
        nodes.iter().rev().fold(NodePtr::NIL, |tail, node| {
            allocator.new_pair(*node, tail).unwrap()
        })
    }

    fn valid_record(allocator: &mut Allocator) -> NodePtr {
        let validator = atom(allocator, 2);
        let validators = list(allocator, &[validator]);
        let fields = [
            NodePtr::NIL,
            NodePtr::NIL,
            atom(allocator, 1),
            NodePtr::NIL,
            NodePtr::NIL,
            NodePtr::NIL,
            NodePtr::NIL,
            NodePtr::NIL,
            NodePtr::NIL,
            validators,
            NodePtr::NIL,
        ];
        list(allocator, &fields)
    }

    fn success(allocator: &mut Allocator, records: NodePtr) -> NodePtr {
        let tag = atom(allocator, 1);
        list(allocator, &[tag, records])
    }

    #[test]
    fn rejects_malformed_envelopes_and_records() {
        let cases: &[(&str, fn(&mut Allocator) -> NodePtr)] = &[
            ("proper result", |allocator| {
                let tag = atom(allocator, 1);
                allocator.new_pair(tag, tag).unwrap()
            }),
            ("result tag is not canonical boolean", |allocator| {
                let tag = atom(allocator, 2);
                list(allocator, &[tag, NodePtr::NIL])
            }),
            ("returned no games", |allocator| {
                success(allocator, NodePtr::NIL)
            }),
            ("is not a proper list", |allocator| {
                let record = atom(allocator, 2);
                let records = list(allocator, &[record]);
                success(allocator, records)
            }),
            ("fields, expected 11", |allocator| {
                let record = list(allocator, &[NodePtr::NIL]);
                let records = list(allocator, &[record]);
                success(allocator, records)
            }),
        ];

        for (expected, malformed) in cases {
            let mut allocator = Allocator::new();
            let result = malformed(&mut allocator);
            let error = parse_factory_result(&allocator, result, "test factory")
                .err()
                .expect("malformed factory result was accepted");
            assert!(error.contains(expected), "unexpected error: {error}");
        }
    }

    #[test]
    fn rejects_noncanonical_turn_and_malformed_validators() {
        let cases: &[(&str, fn(&mut Allocator, &mut [NodePtr; 11]))] = &[
            (
                "proposer_goes_first is not canonical boolean",
                |allocator, fields| {
                    fields[2] = atom(allocator, 2);
                },
            ),
            (
                "validation programs are not a proper list",
                |allocator, fields| {
                    let validator = atom(allocator, 2);
                    fields[9] = allocator.new_pair(validator, validator).unwrap();
                },
            ),
            ("returned no validation programs", |_, fields| {
                fields[9] = NodePtr::NIL;
            }),
            ("validation program 0 is nil", |allocator, fields| {
                fields[9] = list(allocator, &[NodePtr::NIL]);
            }),
            ("validation program 1 is duplicated", |allocator, fields| {
                let validator = atom(allocator, 2);
                fields[9] = list(allocator, &[validator, validator]);
            }),
        ];

        for (expected, mutate) in cases {
            let mut allocator = Allocator::new();
            let record = valid_record(&mut allocator);
            let mut fields: [NodePtr; 11] =
                proper_list(&allocator, record).unwrap().try_into().unwrap();
            mutate(&mut allocator, &mut fields);
            let record = list(&mut allocator, &fields);
            let records = list(&mut allocator, &[record]);
            let result = success(&mut allocator, records);
            let error = parse_factory_result(&allocator, result, "test factory")
                .err()
                .expect("malformed factory result was accepted");
            assert!(error.contains(expected), "unexpected error: {error}");
        }
    }

    #[test]
    fn rejects_non_atoms_and_out_of_range_numeric_fields() {
        let cases: &[(&str, fn(&mut Allocator, &mut [NodePtr; 11]))] = &[
            (
                "proposer_contribution is not an atom",
                |allocator, fields| {
                    fields[0] = allocator.new_pair(NodePtr::NIL, NodePtr::NIL).unwrap();
                },
            ),
            ("accepter_contribution is negative", |allocator, fields| {
                fields[1] = allocator.new_atom(&[0x80]).unwrap();
            }),
            ("contributions exceed u64", |allocator, fields| {
                fields[0] = allocator
                    .new_atom(&[0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
                    .unwrap();
                fields[1] = atom(allocator, 1);
            }),
            ("initial_move is not an atom", |allocator, fields| {
                fields[3] = allocator.new_pair(NodePtr::NIL, NodePtr::NIL).unwrap();
            }),
            ("initial_max_move_size exceeds u32", |allocator, fields| {
                fields[4] = allocator.new_atom(&[1, 0, 0, 0, 0]).unwrap();
            }),
            (
                "initial_mover_share 1 exceeds amount 0",
                |allocator, fields| {
                    fields[6] = atom(allocator, 1);
                },
            ),
        ];

        for (expected, mutate) in cases {
            let mut allocator = Allocator::new();
            let record = valid_record(&mut allocator);
            let mut fields: [NodePtr; 11] =
                proper_list(&allocator, record).unwrap().try_into().unwrap();
            mutate(&mut allocator, &mut fields);
            let record = list(&mut allocator, &fields);
            let records = list(&mut allocator, &[record]);
            let result = success(&mut allocator, records);
            let error = parse_factory_result(&allocator, result, "test factory")
                .err()
                .expect("semantically invalid factory result was accepted");
            assert!(error.contains(expected), "unexpected error: {error}");
        }
    }

    #[test]
    fn parses_shortage_flags_and_named_game_fields() {
        let mut allocator = Allocator::new();
        let false_flag = NodePtr::NIL;
        let true_flag = atom(&mut allocator, 1);
        let shortage = list(&mut allocator, &[false_flag, true_flag, false_flag]);
        match parse_factory_result(&allocator, shortage, "test factory").unwrap() {
            FactoryResultNodes::InsufficientBalance {
                proposer_balance_short,
                accepter_balance_short,
            } => {
                assert!(proposer_balance_short);
                assert!(!accepter_balance_short);
            }
            FactoryResultNodes::Success(_) => panic!("shortage parsed as success"),
        }

        let record = valid_record(&mut allocator);
        let expected = proper_list(&allocator, record).unwrap()[9];
        let expected = proper_list(&allocator, expected).unwrap()[0];
        let records = list(&mut allocator, &[record]);
        let success = success(&mut allocator, records);
        match parse_factory_result(&allocator, success, "test factory").unwrap() {
            FactoryResultNodes::Success(records) => {
                assert_eq!(records[0].validation_programs[0], expected);
                assert!(records[0].proposer_goes_first);
                assert_eq!(records[0].proposer_contribution, 0);
                assert_eq!(records[0].accepter_contribution, 0);
                assert_eq!(records[0].amount, 0);
                assert!(records[0].initial_move.is_empty());
                assert_eq!(records[0].initial_max_move_size, 0);
                assert_eq!(records[0].initial_state, NodePtr::NIL);
                assert_eq!(records[0].initial_mover_share, 0);
                assert_eq!(records[0].my_turn_handler, NodePtr::NIL);
                assert_eq!(records[0].their_turn_handler, NodePtr::NIL);
                assert_eq!(records[0].readable_parameters, NodePtr::NIL);
            }
            FactoryResultNodes::InsufficientBalance { .. } => panic!("success parsed as shortage"),
        }
    }
}
