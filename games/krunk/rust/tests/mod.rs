pub mod dict_tree_lookup;
pub mod handlers;
pub mod sim;
pub mod validation;

pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
    let mut funs = handlers::test_funs();
    funs.extend(validation::test_funs());
    funs.extend(dict_tree_lookup::test_funs());
    #[cfg(feature = "sim-tests")]
    funs.extend(sim::test_funs());
    funs
}
