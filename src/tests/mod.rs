use exec::execvp;
use std::ffi::OsString;

pub mod calpoker;
pub mod channel_handler;
pub mod chialisp;
pub mod constants;
pub mod game;
pub mod game_handler;
pub mod peer;
#[cfg(feature = "sim-tests")]
pub mod simenv;
pub mod standard_coin;

fn detect_run_as_python(args: &[String]) -> bool {
    args.iter().any(|x: &String| x == "-c")
}

// Catch attempts on macos to run the test rig as 'python' and run python code in it.
#[ctor::ctor]
fn init() {
    let args = std::env::args();
    let args_vec: Vec<String> = args.collect();
    if detect_run_as_python(&args_vec) {
        let new_args: Vec<OsString> = args_vec
            .iter()
            .enumerate()
            .map(
                |(i, arg)| {
                    if i == 0 {
                        "python3".into()
                    } else {
                        arg.into()
                    }
                },
            )
            .collect();
        let exec_err = execvp("python3", &new_args);
        eprintln!("Error Running: {:?}\n{:?}\n", new_args, exec_err);
    }
}
