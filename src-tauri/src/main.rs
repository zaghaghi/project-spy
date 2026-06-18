// Project Spy desktop shell.
//
// Inference runs in-process via llama-cpp-2 on Metal GPU. The user picks a
// brain (QAT GGUF of gemma-4) from the UI; on first use it's downloaded from
// HuggingFace to ~/.project-spy/brains/ and then loaded. A tiny localhost
// axum server exposes the Anthropic-compatible API the React UI uses.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use project_spy::brains;
use project_spy::inference::Engine;
use project_spy::server;
use tauri::{Manager, RunEvent};

fn main() {
    // Capture stderr to ~/.project-spy/last-run.log BEFORE the inference worker
    // starts. llama.cpp's ggml_abort writes its reason to C stderr (fd 2) via
    // fprintf and then calls abort() — a hard SIGABRT Rust can't catch. Without
    // this redirect that message is lost in the bundled app (no console), so a
    // crash leaves only an opaque OS crash report. Hold the file handle for the
    // process lifetime so the dup2 target stays open.
    #[cfg(unix)]
    let _log_file = redirect_stderr_to_log();

    let app = tauri::Builder::default()
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
        .build(tauri::generate_context!())
        .expect("error while building Project Spy");

    // ggml's Metal backend registers a C++ static destructor that runs via libc
    // `atexit` during the normal `exit()` path the Tauri/tao event loop falls
    // through to on quit. That destructor tears down the Metal device and calls
    // `ggml_abort` from inside `ggml_metal_rsets_free`, which `abort()`s the
    // process — the "Project Spy closed unexpectedly" crash dialog. We intercept
    // quit and terminate with the raw POSIX `_exit(0)`, which skips `atexit`
    // entirely so the destructor never runs; the OS just reclaims the process.
    app.run(|_app_handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            unsafe { libc::_exit(0) };
        }
    });
}

/// Open the log file and point fd 2 (stderr) at it. Returns the file handle so
/// the caller can keep it alive. No-op (returns None) if the file can't be
/// opened — a missing log never blocks the app.
#[cfg(unix)]
fn redirect_stderr_to_log() -> Option<std::fs::File> {
    let path = brains::log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .ok()?;

    use std::os::fd::AsRawFd;
    // dup2 the file onto fd 2 so both Rust's eprintln! and C/C++ fprintf(stderr)
    // (ggml_abort's message) land in the log.
    if unsafe { libc::dup2(file.as_raw_fd(), 2) } == -1 {
        return None;
    }
    eprintln!("[project-spy] --- new session: stderr captured to {} ---", path.display());
    Some(file)
}
