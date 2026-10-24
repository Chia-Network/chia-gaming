pub mod channel_state;
pub mod chialisp;
pub mod constants;
pub mod pack;
pub mod referee_conditions;
pub mod shapes;
pub mod standard_coin;

/// Construct/read the native # layout in fixtures without list terminators.
pub(crate) fn shape_tree(
    a: &mut crate::common::types::AllocEncoder,
    fields: &[clvmr::allocator::NodePtr],
) -> clvmr::allocator::NodePtr {
    if fields.len() == 1 {
        return fields[0];
    }
    assert!(!fields.is_empty());
    let mid = fields.len() / 2;
    let left = shape_tree(a, &fields[..mid]);
    let right = shape_tree(a, &fields[mid..]);
    a.allocator().new_pair(left, right).unwrap()
}
pub(crate) fn shape_fields(
    a: &clvmr::Allocator,
    node: clvmr::allocator::NodePtr,
    count: usize,
) -> Vec<clvmr::allocator::NodePtr> {
    if count == 1 {
        return vec![node];
    }
    let clvmr::allocator::SExp::Pair(left, right) = a.sexp(node) else {
        panic!("expected shape pair")
    };
    let mid = count / 2;
    let mut fields = shape_fields(a, left, mid);
    fields.extend(shape_fields(a, right, count - mid));
    fields
}
/// Expose semantic result fields to existing game assertions, including each extra condition.
pub(crate) fn validator_fields(
    a: &clvmr::Allocator,
    node: clvmr::allocator::NodePtr,
) -> Option<Vec<clvmr::allocator::NodePtr>> {
    let Some([hash, state, size, conditions]) =
        crate::referee::types::validator_result_fields(a, node).ok()?
    else {
        return Some(vec![]);
    };
    let mut fields = vec![hash, state, size];
    fields.extend(crate::utils::proper_list(a, conditions, true)?);
    Some(fields)
}
pub(crate) fn validator_tree(
    a: &mut crate::common::types::AllocEncoder,
    fields: &[clvmr::allocator::NodePtr],
) -> clvmr::allocator::NodePtr {
    use clvmr::allocator::NodePtr;
    let hash = fields.first().copied().unwrap_or(NodePtr::NIL);
    let state = fields.get(1).copied().unwrap_or(NodePtr::NIL);
    let size = fields.get(2).copied().unwrap_or(NodePtr::NIL);
    let mut conditions = NodePtr::NIL;
    for field in fields.get(3..).unwrap_or(&[]).iter().rev() {
        conditions = a.allocator().new_pair(*field, conditions).unwrap();
    }
    let transition = a.allocator().new_pair(hash, state).unwrap();
    let effects = a.allocator().new_pair(size, conditions).unwrap();
    a.allocator().new_pair(transition, effects).unwrap()
}
