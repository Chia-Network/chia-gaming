use clvmr::allocator::SExp;
use clvmr::reduction::EvalErr;
use clvmr::{Allocator, NodePtr};
use num_bigint::BigInt;

pub fn map_m<T, U, E, F>(mut f: F, list: &[T]) -> Result<Vec<U>, E>
where
    F: FnMut(&T) -> Result<U, E>,
{
    let mut result = Vec::new();
    for e in list {
        let val = f(e)?;
        result.push(val);
    }
    Ok(result)
}

pub fn non_nil(allocator: &Allocator, sexp: NodePtr) -> bool {
    match allocator.sexp(sexp) {
        SExp::Pair(_, _) => true,
        // sexp is the only node in scope, was !is_empty
        SExp::Atom => allocator.atom_len(sexp) != 0,
    }
}

pub fn proper_list(allocator: &Allocator, sexp: NodePtr, store: bool) -> Option<Vec<NodePtr>> {
    let mut args = vec![];
    let mut args_sexp = sexp;
    loop {
        match allocator.sexp(args_sexp) {
            SExp::Atom => {
                if !non_nil(allocator, args_sexp) {
                    return Some(args);
                } else {
                    return None;
                }
            }
            SExp::Pair(f, r) => {
                if store {
                    args.push(f);
                }
                args_sexp = r;
            }
        }
    }
}

pub fn enlist(allocator: &mut Allocator, vec: &[NodePtr]) -> Result<NodePtr, EvalErr> {
    let mut built = NodePtr::NIL;

    for i_reverse in 0..vec.len() {
        let i = vec.len() - i_reverse - 1;
        match allocator.new_pair(vec[i], built) {
            Err(e) => return Err(e),
            Ok(v) => {
                built = v;
            }
        }
    }
    Ok(built)
}

pub fn first(allocator: &Allocator, sexp: NodePtr) -> Result<NodePtr, EvalErr> {
    match allocator.sexp(sexp) {
        SExp::Pair(f, _) => Ok(f),
        _ => Err(EvalErr(sexp, "first of non-cons".to_string())),
    }
}

pub fn number_from_u8(v: &[u8]) -> BigInt {
    let len = v.len();
    if len == 0 {
        0.into()
    } else {
        BigInt::from_signed_bytes_be(v)
    }
}

pub fn u8_from_number(v: BigInt) -> Vec<u8> {
    v.to_signed_bytes_be()
}

#[cfg(test)]
pub fn pair_of_array_mut<X>(arr: &mut [X]) -> (&mut X, &mut X) {
    let (f, r) = arr.split_at_mut(1);
    (&mut f[0], &mut r[0])
}
