use std::sync::Mutex;

use lazy_static::lazy_static;
use salvo::prelude::*;

use chia_gaming::channel_handler::runner::ChannelHandlerParty;

struct GameRunner {
}

lazy_static! {
    static ref mutex: Mutex<GameRunner> = Mutex::new(GameRunner::new());
}

impl GameRunner {
    fn new() -> Self {
        GameRunner { }
    }

    fn index(&self) -> String {
        "<html><body>Coming soon</body></html>".to_string()
    }

    fn start_game(&mut self) -> String {
        "start".to_string()
    }
}

#[handler]
async fn index() -> Result<String, String> {
    let locked = mutex.try_lock().map_err(|e| format!("{e:?}"))?;
    Ok((*locked).index())
}

#[handler]
async fn start_game(req: &mut Request) -> Result<String, String> {
    let mut locked = mutex.try_lock().map_err(|e| format!("{e:?}"))?;
    Ok((*locked).start_game())
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().init();

    let router = Router::new().get(index).push(
        Router::with_path("start").post(start_game)
    );
    let acceptor = TcpListener::new("127.0.0.1:5800").bind().await;
    Server::new(acceptor).serve(router).await;
}
