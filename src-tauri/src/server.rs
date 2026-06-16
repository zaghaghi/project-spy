// Tiny in-process HTTP server exposing the same Anthropic-compatible API the
// React UI already speaks (/v1/messages) plus /health for the startup gate.
// Binds to localhost only; CORS is permissive for the Tauri webview origin.

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use tower_http::cors::CorsLayer;

use crate::brains;
use crate::inference::Engine;

pub const HOST: &str = "127.0.0.1";
pub const PORT: u16 = 8787;

#[derive(Deserialize)]
struct AnthropicMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct AnthropicRequest {
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    system: Option<String>,
    #[serde(default)]
    messages: Vec<AnthropicMessage>,
    #[serde(default)]
    max_tokens: Option<usize>,
}

pub async fn serve(engine: Engine) -> anyhow::Result<()> {
    let app = Router::new()
        .route("/health", get(health))
        .route("/status", get(health))
        .route("/brains", get(brains_list))
        .route("/load", post(load_brain))
        .route("/v1/messages", post(messages))
        .layer(CorsLayer::very_permissive())
        .with_state(engine);

    let listener = tokio::net::TcpListener::bind((HOST, PORT)).await?;
    println!("[project-spy] inference server on http://{HOST}:{PORT}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health(State(engine): State<Engine>) -> impl IntoResponse {
    Json(engine.status())
}

async fn brains_list() -> impl IntoResponse {
    Json(json!({
        "systemMemoryBytes": brains::total_memory_bytes(),
        "brains": brains::listing(),
    }))
}

#[derive(Deserialize)]
struct LoadRequest {
    id: String,
}

async fn load_brain(
    State(engine): State<Engine>,
    Json(req): Json<LoadRequest>,
) -> impl IntoResponse {
    match engine.load(&req.id) {
        Ok(()) => (StatusCode::ACCEPTED, Json(json!({ "ok": true }))),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "ok": false, "error": e })),
        ),
    }
}

async fn messages(
    State(engine): State<Engine>,
    Json(req): Json<AnthropicRequest>,
) -> impl IntoResponse {
    let status = engine.status();
    if !status.model_ready {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "type": "error",
                "error": { "type": "model_loading", "message": status.message, "status": status }
            })),
        );
    }

    let history: Vec<(String, String)> = req
        .messages
        .into_iter()
        .map(|m| (m.role, m.content))
        .collect();
    let max_tokens = req.max_tokens.unwrap_or(700);

    match engine
        .generate(req.system.as_deref(), &history, max_tokens)
        .await
    {
        Ok(text) => (
            StatusCode::OK,
            Json(json!({
                "id": format!("msg_{}", &uuid_like()),
                "type": "message",
                "role": "assistant",
                "model": req.model.unwrap_or_else(|| status.model_name.clone()),
                "content": [{ "type": "text", "text": text }],
                "stop_reason": "end_turn",
                "stop_sequence": serde_json::Value::Null
            })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({
                "type": "error",
                "error": { "type": "internal", "message": e.to_string() }
            })),
        ),
    }
}

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{n:x}")
}
