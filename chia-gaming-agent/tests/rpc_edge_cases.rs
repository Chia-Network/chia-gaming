use std::net::SocketAddr;
use std::time::Duration;

use chia_gaming_agent::config::AgentConfig;
use chia_gaming_agent::full_node::FullNodeClient;
use chia_gaming_agent::keys::LoadedWallet;
use chia_gaming_agent::rpc::{handle_json_rpc, router, AppState, JsonRpcRequest};
use serde_json::json;
use tokio::sync::RwLock;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const TEST_MNEMONIC: &str =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

fn test_wallet() -> LoadedWallet {
    LoadedWallet::from_mnemonic_str(TEST_MNEMONIC, 0).expect("test mnemonic")
}

fn app_state(mock_uri: &str, shared_secret: Option<&str>) -> AppState {
    let wallet = test_wallet();
    let cfg = AgentConfig {
        full_node_url: mock_uri.to_string(),
        tls_insecure_skip_verify: true,
        mnemonic_path: String::new(),
        shared_secret: shared_secret.map(|s| s.to_string()),
        ..AgentConfig::default()
    };
    let node = FullNodeClient::new(&cfg.full_node_url, true).expect("client");
    AppState {
        cfg,
        wallet,
        node,
        registered_coin_names: std::sync::Arc::new(RwLock::new(std::collections::HashSet::new())),
        remote_wallet_id: std::sync::Arc::new(RwLock::new(None)),
    }
}

async fn spawn_agent(state: AppState) -> SocketAddr {
    let app = router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    addr
}

async fn rpc_http(
    addr: SocketAddr,
    method: &str,
    params: serde_json::Value,
    token: Option<&str>,
) -> reqwest::Response {
    let client = reqwest::Client::new();
    let body = json!({
        "jsonrpc": "2.0",
        "id": 42,
        "method": method,
        "params": params,
    });
    let mut req = client.post(format!("http://{addr}/v1/rpc")).json(&body);
    if let Some(tok) = token {
        req = req.header("x-chia-gaming-agent-token", tok);
    }
    req.send().await.expect("post")
}

#[tokio::test]
async fn fingerprint_mismatch_returns_rpc_error() {
    let mock = MockServer::start().await;
    let state = app_state(&mock.uri(), None);
    let req = JsonRpcRequest {
        jsonrpc: Some("2.0".to_string()),
        id: Some(json!(99)),
        method: "chia_getWallets".to_string(),
        params: json!({ "fingerprint": (state.wallet.fingerprint as u64) + 1 }),
    };
    let resp = handle_json_rpc(&state, req).await;
    assert_eq!(resp.id, Some(json!(99)));
    let err = resp.error.expect("error");
    assert_eq!(err.code, -32000);
    assert!(err.message.contains("fingerprint mismatch"));
}

#[tokio::test]
async fn unknown_method_returns_rpc_error() {
    let mock = MockServer::start().await;
    let state = app_state(&mock.uri(), None);
    let req = JsonRpcRequest {
        jsonrpc: Some("2.0".to_string()),
        id: Some(json!(7)),
        method: "chia_not_real".to_string(),
        params: json!({}),
    };
    let resp = handle_json_rpc(&state, req).await;
    assert_eq!(resp.id, Some(json!(7)));
    let err = resp.error.expect("error");
    assert!(err.message.contains("unknown method"));
}

#[tokio::test]
async fn null_params_default_to_empty_object() {
    let mock = MockServer::start().await;
    let state = app_state(&mock.uri(), None);
    let req = JsonRpcRequest {
        jsonrpc: Some("2.0".to_string()),
        id: Some(json!(3)),
        method: "chia_getWallets".to_string(),
        params: serde_json::Value::Null,
    };
    let resp = handle_json_rpc(&state, req).await;
    let arr = resp.result.expect("result").as_array().cloned().expect("array");
    assert!(!arr.is_empty());
}

#[tokio::test]
async fn select_coins_invalid_amount_errors() {
    let mock = MockServer::start().await;
    let state = app_state(&mock.uri(), None);
    let req = JsonRpcRequest {
        jsonrpc: Some("2.0".to_string()),
        id: Some(json!(1)),
        method: "chia_selectCoins".to_string(),
        params: json!({ "amount": "not-a-number" }),
    };
    let resp = handle_json_rpc(&state, req).await;
    let err = resp.error.expect("error");
    assert!(err.message.contains("invalid amount"));
}

#[tokio::test]
async fn select_coins_returns_success_false_when_no_match() {
    let mock = MockServer::start().await;
    let wallet = test_wallet();
    let ph = format!("0x{}", hex::encode(wallet.puzzle_hash_bytes()));
    Mock::given(method("POST"))
        .and(path("/get_coin_records_by_puzzle_hashes"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "coin_records": [{
                "coin": {
                    "parent_coin_info": format!("0x{}", "11".repeat(32)),
                    "puzzle_hash": ph,
                    "amount": 500u64
                },
                "spent": false,
                "spent_block_index": 0
            }],
            "success": true
        })))
        .mount(&mock)
        .await;

    let state = app_state(&mock.uri(), None);
    let req = JsonRpcRequest {
        jsonrpc: Some("2.0".to_string()),
        id: Some(json!(1)),
        method: "chia_selectCoins".to_string(),
        params: json!({ "amount": "1000" }),
    };
    let resp = handle_json_rpc(&state, req).await;
    let out = resp.result.expect("result");
    assert_eq!(out["success"], false);
    assert_eq!(out["coins"], json!([]));
}

#[tokio::test]
async fn coin_records_map_snake_and_camel_case() {
    let mock = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/get_coin_records_by_names"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "coin_records": [
                {
                    "coin": {"amount": 1},
                    "confirmed_block_index": 11,
                    "spent_block_index": 22,
                    "spent": true,
                    "coinbase": false,
                    "timestamp": 123
                },
                {
                    "coin": {"amount": 2},
                    "confirmedBlockIndex": 33,
                    "spentBlockIndex": 44,
                    "spent": false,
                    "coinbase": true,
                    "timestamp": 456
                }
            ],
            "success": true
        })))
        .mount(&mock)
        .await;

    let state = app_state(&mock.uri(), None);
    let req = JsonRpcRequest {
        jsonrpc: Some("2.0".to_string()),
        id: Some(json!(1)),
        method: "chia_getCoinRecordsByNames".to_string(),
        params: json!({
            "names": [format!("0x{}", "aa".repeat(32))],
            "includeSpentCoins": true
        }),
    };
    let resp = handle_json_rpc(&state, req).await;
    let arr = resp
        .result
        .expect("result")["coinRecords"]
        .as_array()
        .cloned()
        .expect("array");
    assert_eq!(arr.len(), 2);
    assert_eq!(arr[0]["confirmedBlockIndex"], 11);
    assert_eq!(arr[1]["confirmedBlockIndex"], 33);
}

#[tokio::test]
async fn puzzle_and_solution_surfaces_fullnode_error() {
    let mock = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/get_puzzle_and_solution"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "error": "coin not found",
            "success": false
        })))
        .mount(&mock)
        .await;

    let state = app_state(&mock.uri(), None);
    let req = JsonRpcRequest {
        jsonrpc: Some("2.0".to_string()),
        id: Some(json!(1)),
        method: "chia_getPuzzleAndSolution".to_string(),
        params: json!({ "coinName": format!("0x{}", "bb".repeat(32)) }),
    };
    let resp = handle_json_rpc(&state, req).await;
    let err = resp.error.expect("error");
    assert!(err.message.contains("coin not found"));
}

#[tokio::test]
async fn push_tx_defaults_to_unknown_status_when_missing() {
    let mock = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/push_tx"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "success": true
        })))
        .mount(&mock)
        .await;

    let state = app_state(&mock.uri(), None);
    let req = JsonRpcRequest {
        jsonrpc: Some("2.0".to_string()),
        id: Some(json!(1)),
        method: "chia_walletPushTx".to_string(),
        params: json!({
            "spendBundle": {"aggregated_signature":"0x00", "coin_spends":[]}
        }),
    };
    let resp = handle_json_rpc(&state, req).await;
    assert_eq!(resp.result.expect("result")["status"], "UNKNOWN");
}

#[tokio::test]
async fn auth_middleware_rejects_missing_or_bad_token() {
    let mock = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/get_blockchain_state"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "blockchain_state": {
                "sync": {"prev_transaction_block_height": 1, "latest_block_height": 1},
                "peak": {"height": 1}
            },
            "success": true
        })))
        .mount(&mock)
        .await;

    let state = app_state(&mock.uri(), Some("shh"));
    let addr = spawn_agent(state).await;

    let missing = rpc_http(addr, "chia_getHeightInfo", json!({}), None).await;
    assert_eq!(missing.status(), reqwest::StatusCode::UNAUTHORIZED);

    let wrong = rpc_http(addr, "chia_getHeightInfo", json!({}), Some("bad")).await;
    assert_eq!(wrong.status(), reqwest::StatusCode::UNAUTHORIZED);

    let ok = rpc_http(addr, "chia_getHeightInfo", json!({}), Some("shh")).await;
    assert_eq!(ok.status(), reqwest::StatusCode::OK);
}

