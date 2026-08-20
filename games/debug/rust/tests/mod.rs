pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
    super::test_funs()
}
