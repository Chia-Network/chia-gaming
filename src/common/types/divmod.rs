use num_bigint::{BigInt, ToBigInt};

pub fn divmod(a: BigInt, b: BigInt) -> (BigInt, BigInt) {
    let d = a.clone() / b.clone();
    let r = a.clone() % b.clone();
    let zero = 0.to_bigint().unwrap();
    if d < zero && r != zero {
        (d - 1.to_bigint().unwrap(), r + b)
    } else {
        (d, r)
    }
}

// Collected only by the sim-tests runner (simulator is feature-gated).
#[cfg(all(test, feature = "sim-tests"))]
fn test_local_divmod() {
    assert_eq!(
        divmod((-7).to_bigint().unwrap(), 2.to_bigint().unwrap()),
        ((-4).to_bigint().unwrap(), 1.to_bigint().unwrap())
    );
    assert_eq!(
        divmod(7.to_bigint().unwrap(), (-2).to_bigint().unwrap()),
        ((-4).to_bigint().unwrap(), (-1).to_bigint().unwrap())
    );
    assert_eq!(
        divmod((-7).to_bigint().unwrap(), (-2).to_bigint().unwrap()),
        (3.to_bigint().unwrap(), (-1).to_bigint().unwrap())
    );
    assert_eq!(
        divmod(7.to_bigint().unwrap(), 2.to_bigint().unwrap()),
        (3.to_bigint().unwrap(), 1.to_bigint().unwrap())
    );
}

#[cfg(all(test, feature = "sim-tests"))]
pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
    vec![("test_local_divmod", &test_local_divmod)]
}
