use std::fs;
use std::sync::Mutex;

use lazy_static::lazy_static;
use salvo::http::ResBody;
use salvo::hyper::body::Bytes;
use salvo::prelude::*;

struct GameRunner {}

lazy_static! {
    static ref MUTEX: Mutex<GameRunner> = Mutex::new(GameRunner::new());
}

impl GameRunner {
    fn new() -> Self {
        GameRunner {}
    }

    #[allow(dead_code)]
    fn index(&self) -> String {
        "<html><body>Coming soon</body></html>".to_string()
    }

    fn start_game(&mut self) -> String {
        "start".to_string()
    }
}

fn get_file(name: &str, content_type: &str, response: &mut Response) -> Result<(), String> {
    let content = fs::read_to_string(name).map_err(|e| format!("{e:?}"))?;
    response
        .add_header("Content-Type", content_type, true)
        .map_err(|e| format!("{e:?}"))?;
    response.replace_body(ResBody::Once(Bytes::from(content.as_bytes().to_vec())));
    Ok(())
}

#[handler]
async fn index(response: &mut Response) -> Result<(), String> {
    get_file("resources/web/index.html", "text/html", response)
}

#[handler]
async fn index_js(response: &mut Response) -> Result<(), String> {
    get_file("resources/web/index.js", "text/javascript", response)
}

#[handler]
async fn index_css(response: &mut Response) -> Result<(), String> {
    get_file("resources/web/index.css", "text/css", response)
}

#[handler]
async fn start_game(_req: &mut Request) -> Result<String, String> {
    let mut locked = MUTEX.try_lock().map_err(|e| format!("{e:?}"))?;
    Ok((*locked).start_game())
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt().init();

    let router = Router::new()
        .get(index)
        .push(Router::with_path("start").post(start_game))
        .push(Router::with_path("index.css").get(index_css))
        .push(Router::with_path("index.js").get(index_js));
    let acceptor = TcpListener::new("127.0.0.1:5800").bind().await;
    Server::new(acceptor).serve(router).await;
}
