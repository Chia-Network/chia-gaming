use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use chia_gaming_agent::config::AgentConfig;
use chia_gaming_agent::full_node::FullNodeClient;
use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn unique_tmp_dir(name: &str) -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    std::env::temp_dir().join(format!("chia_gaming_agent_{name}_{nanos}"))
}

#[test]
fn config_loads_yaml_and_json() {
    let dir = unique_tmp_dir("config");
    fs::create_dir_all(&dir).expect("mkdir");

    let yaml_path = dir.join("agent.yaml");
    fs::write(
        &yaml_path,
        r#"
full_node_url: "https://example.com:8555"
listen: "127.0.0.1:9999"
mnemonic_path: "wallet.key"
wallet_derivation_index: 7
testnet: true
tls_insecure_skip_verify: true
shared_secret: "abc"
"#,
    )
    .expect("write yaml");
    let yaml_cfg = AgentConfig::load(&yaml_path).expect("yaml parse");
    assert_eq!(yaml_cfg.full_node_url, "https://example.com:8555");
    assert_eq!(yaml_cfg.listen, "127.0.0.1:9999");
    assert_eq!(yaml_cfg.wallet_derivation_index, 7);
    assert!(yaml_cfg.testnet);
    assert!(yaml_cfg.tls_insecure_skip_verify);
    assert_eq!(yaml_cfg.shared_secret.as_deref(), Some("abc"));

    let json_path = dir.join("agent.json");
    fs::write(
        &json_path,
        r#"{
  "full_node_url":"https://example.org:8555",
  "listen":"127.0.0.1:9988",
  "mnemonic_path":"wallet.key",
  "wallet_derivation_index":5,
  "testnet":false,
  "tls_insecure_skip_verify":false,
  "shared_secret":"zzz"
}"#,
    )
    .expect("write json");
    let json_cfg = AgentConfig::load(&json_path).expect("json parse");
    assert_eq!(json_cfg.full_node_url, "https://example.org:8555");
    assert_eq!(json_cfg.listen, "127.0.0.1:9988");
    assert_eq!(json_cfg.wallet_derivation_index, 5);
    assert_eq!(json_cfg.shared_secret.as_deref(), Some("zzz"));

    let _ = fs::remove_dir_all(dir);
}

#[test]
fn config_listen_addr_validation() {
    let cfg = AgentConfig {
        listen: "127.0.0.1:7777".to_string(),
        ..AgentConfig::default()
    };
    assert!(cfg.listen_addr().is_ok());

    let bad = AgentConfig {
        listen: "not-an-addr".to_string(),
        ..AgentConfig::default()
    };
    assert!(bad.listen_addr().is_err());
}

#[tokio::test]
async fn full_node_client_success_and_endpoint_trimming() {
    let mock = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/get_blockchain_state"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "ok": true
        })))
        .mount(&mock)
        .await;

    let client = FullNodeClient::new(&(mock.uri() + "/"), true).expect("client");
    let out = client
        .post("/get_blockchain_state", json!({}))
        .await
        .expect("post");
    assert_eq!(out["ok"], true);
}

#[tokio::test]
async fn full_node_client_reports_http_and_json_errors() {
    let mock = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/bad_http"))
        .respond_with(ResponseTemplate::new(500).set_body_string("nope"))
        .mount(&mock)
        .await;
    Mock::given(method("POST"))
        .and(path("/bad_json"))
        .respond_with(ResponseTemplate::new(200).set_body_string("not-json"))
        .mount(&mock)
        .await;

    let client = FullNodeClient::new(&mock.uri(), true).expect("client");
    let http_err = client.post("bad_http", json!({})).await.expect_err("http err");
    assert!(http_err.to_string().contains("HTTP 500"));

    let json_err = client.post("bad_json", json!({})).await.expect_err("json err");
    assert!(json_err.to_string().contains("full node bad_json json"));
}

