/// Panics in debug/test builds; returns `Err(Error::StrErr(...))` in release.
macro_rules! game_assert {
    ($cond:expr, $($arg:tt)+) => {{
        debug_assert!($cond, $($arg)+);
        if !$cond {
            return Err($crate::common::types::Error::StrErr(format!($($arg)+)));
        }
    }};
}

/// Panics in debug/test builds; returns `Err(Error::StrErr(...))` in release.
macro_rules! game_assert_eq {
    ($left:expr, $right:expr, $($arg:tt)+) => {{
        debug_assert_eq!($left, $right, $($arg)+);
        if $left != $right {
            return Err($crate::common::types::Error::StrErr(format!($($arg)+)));
        }
    }};
}
