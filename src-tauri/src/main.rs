// Project Spy desktop shell.
//
// Inference runs in-process via mistral.rs on a background tokio runtime, loading
// a UQFF build of gemma-4-E2B that is bundled inside the app (no download). A
// tiny localhost server exposes the Anthropic-compatible API the React UI uses.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use project_spy::inference::Engine;
use project_spy::server;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let engine = Engine::new();

            // Start the worker; it stays idle until the player picks a brain to
            // download/load via the UI (POST /load).
            engine.start();

            // Serve the HTTP API on a tokio runtime; /health and /brains are live
            // immediately so the UI can show the brain picker and load progress.
            let engine_srv = engine.clone();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                    .expect("failed to build tokio runtime");
                rt.block_on(async move {
                    if let Err(e) = server::serve(engine_srv).await {
                        eprintln!("[project-spy] server error: {e}");
                    }
                });
            });

            app.manage(engine);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Project Spy");
}
