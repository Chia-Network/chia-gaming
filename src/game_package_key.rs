pub(crate) fn validate_game_package_key(key: &str) -> Result<(), &'static str> {
    if key == "host" {
        return Err("host is reserved for the portable game contract");
    }

    let mut chars = key.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_lowercase()) {
        return Err("must start with a lowercase ASCII letter");
    }
    if !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') {
        return Err("must contain only lowercase ASCII letters, digits, and underscores");
    }
    if is_rust_keyword(key) {
        return Err("must not be a Rust keyword");
    }

    Ok(())
}

fn is_rust_keyword(key: &str) -> bool {
    matches!(
        key,
        "abstract"
            | "as"
            | "async"
            | "await"
            | "become"
            | "box"
            | "break"
            | "const"
            | "continue"
            | "crate"
            | "do"
            | "dyn"
            | "else"
            | "enum"
            | "extern"
            | "false"
            | "final"
            | "fn"
            | "for"
            | "if"
            | "impl"
            | "in"
            | "let"
            | "loop"
            | "macro"
            | "match"
            | "mod"
            | "move"
            | "mut"
            | "override"
            | "priv"
            | "pub"
            | "ref"
            | "return"
            | "self"
            | "static"
            | "struct"
            | "super"
            | "trait"
            | "true"
            | "try"
            | "type"
            | "typeof"
            | "union"
            | "unsafe"
            | "unsized"
            | "use"
            | "virtual"
            | "where"
            | "while"
            | "yield"
    )
}

#[cfg(test)]
mod tests {
    use super::validate_game_package_key;

    #[test]
    fn accepts_catalog_identifiers() {
        for key in ["calpoker", "space_poker", "game2"] {
            assert_eq!(validate_game_package_key(key), Ok(()));
        }
    }

    #[test]
    fn rejects_non_identifiers_and_reserved_names() {
        for key in [
            "",
            "_game",
            "2game",
            "SpacePoker",
            "space-poker",
            "type",
            "host",
        ] {
            assert!(validate_game_package_key(key).is_err(), "{key:?}");
        }
    }
}
