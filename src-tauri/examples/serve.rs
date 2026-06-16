//! Run the real production server (server.rs + inference.rs) without the GUI.
//! Optionally auto-load a brain with SPY_BRAIN=<id> (partial|full|deep).
//! Run: `cargo run --release --example serve -p project-spy`

use project_spy::inference::Engine;
use project_spy::server;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let engine = Engine::new();
    engine.start();
    if let Ok(id) = std::env::var("SPY_BRAIN") {
        let _ = engine.load(&id);
    }
    server::serve(engine).await?;
    Ok(())
}
