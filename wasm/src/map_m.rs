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
