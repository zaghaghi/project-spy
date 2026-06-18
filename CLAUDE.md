# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Project Spy is a standalone desktop interrogation game (Tauri 2). A player questions a captured spy and must break their will until they confess a known secret. The spy's "brain" is a quantized Gemma GGUF model loaded **in-process** via llama.cpp on the Metal GPU — no cloud, no API keys. Everything runs in one Rust process: the model, a tiny localhost Anthropic-compatible HTTP server, and the bundled React UI that talks to it.

## The core architecture

**"The app is the referee, the model only acts."** This is the load-bearing design principle. A deterministic engine (TypeScript, in `web/src/engine/`) owns the case file, the hidden resolve score, the statement log, tier derivation, contradiction validation, and the win check. The LLM only produces per-turn JSON judgments (`speech`, `tell`, `player_move`, `pressure_point_hit`, `contradiction_of`, `new_statements`, `threads`) — every points-bearing claim is **validated by the engine before it counts**, because the model must never adjudicate its own defeat.

Because the player already knows the secret, nothing is hidden from the client, so the whole referee engine runs in the browser/React layer — **not** in Rust. The Rust side is purely an inference bridge.

### Two layers, one Anthropic-compatible contract

- **Rust backend** (`src-tauri/src/`): downloads a "brain" GGUF from HuggingFace on first use (cached in `~/.project-spy/brains/`), loads it with `llama-cpp-2` on Metal, and serves an Anthropic-compatible `/v1/messages` plus `/health`, `/status`, `/brains`, `/load` on `127.0.0.1:8787` via axum. llama.cpp objects are not `Sync`, so they live on one dedicated **worker thread** (`inference.rs`); the async server talks to it over a `std::sync::mpsc` channel and `oneshot` reply channels. The persistent context keeps its KV cache warm across turns (prompt caching: only new tokens past the common prefix are decoded).
- **TS frontend** (`web/src/`): React + Vite. The referee engine, case ledgers, system/turn prompts, and the `/v1/messages` client. `LocalAnthropicClient` works against both the bundled axum server and LM Studio.

The contract between them is intentionally minimal: a standard Anthropic `/v1/messages` shape. That's why the web UI can develop standalone against LM Studio with no Rust build (see "Two dev modes" below).

### Key files

- `src-tauri/src/inference.rs` — `Engine`: the llama.cpp worker, download-with-progress, Gemma chat-template prompt building (`build_gemma_prompt` — Gemma has no system role, so system text folds into the first user turn), warm-cache `generate`. **N_CTX = 8192.**
- `src-tauri/src/brains.rs` — the brain catalog (QAT GGUF repos), HuggingFace resolve URLs, `~/.project-spy/brains/` cache dir, RAM-fit warning (`SPY_FAKE_RAM_BYTES` to test it). Add/change brains here.
- `src-tauri/src/server.rs` — axum router. `PORT`/`HOST` constants; `SPY_PORT`/`SPY_HOST` env overrides.
- `src-tauri/src/main.rs` — Tauri shell. Starts the engine worker + tokio runtime for the server. **Quirk:** intercepts quit and calls `libc::_exit(0)` to skip ggml's Metal `atexit` destructor, which otherwise `abort()`s the process and shows a crash dialog. Do not remove this.
- `web/src/engine/engine.ts` — `GameEngine`: scoring (`DRAIN` map: `vague_threat +5`, `specific_pressure -10`, `contradiction -20`, `pressure_point -30`, `smalltalk 0`), tier derivation (`tierFor`), the code-side pressure-point **trigger backstop** (trusts neither model nor phrasing alone — a hit counts if *either* fires, scored `-30` only on first hit), contradiction validation (substring + Sørensen-Dice bigram similarity ≥0.6), secret-leak redaction (`guardSecret`), and a **guaranteed** confession on break (the payoff never depends on a weak model cooperating).
- `web/src/engine/cases.ts` — the authoritative case ledgers (secret, true/false facts, pressure points with regex `triggers`). `cases/` JSON are case data files.
- `web/src/engine/llm.ts` — `LocalAnthropicClient` + defensive JSON extraction (`extractJson`/`tryBalanced`) because local models rarely honor strict JSON mode.
- `web/src/engine/prompts.ts` — system prompt + per-turn injected state (`resolve_tier`, turn, recent statements, pressure points hit).

## Two dev modes

**Full app (Tauri + in-process model):**
```bash
npm install                 # one-time: Tauri CLI at repo root
npm --prefix web install
npm run dev                 # = tauri dev; first build of llama.cpp is slow
```

**Web-only against LM Studio (no Rust build):** LM Studio running on `127.0.0.1:1234` with a chat model loaded. The Vite dev server proxies `/v1/*` → LM Studio (same-origin, no CORS). Override with `SPY_BASE_URL=... npm --prefix web run dev`. Note: the bundled app talks to `127.0.0.1:8787` (set via `VITE_SPY_BACKEND`); LM Studio dev uses `1234`.

## Backend headless (curl the model directly)

```bash
cd src-tauri
cargo run --release --example serve -p project-spy                       # idle; /load to pick
SPY_BRAIN=partial cargo run --release --example serve -p project-spy     # auto-load E2B
# curl :8787/brains  ·  curl -XPOST :8787/load -d '{"id":"partial"}'  ·  curl :8787/health
```

## Build / test / lint

```bash
npm run build               # builds web/dist, compiles the app (bundle: app)
npx tauri build --bundles dmg   # also produce a DMG
npm --prefix web run typecheck   # TS typecheck (no Rust-side typecheck beyond cargo)
npm --prefix web run build       # web build alone
npx tsx web/smoke.ts             # drive the TS engine against the live LM Studio endpoint from Node
```

There is no test suite beyond the smoke test; Rust has no unit tests (`cargo test` builds the crate only). Prereqs: Rust stable, Node 20+, **cmake** + Xcode Command Line Tools (full Xcode not required — Metal shaders compile at runtime).

## Distributable / release

`.github/workflows/release.yml` triggers on `release: published`, building macOS (app,dmg), Windows (msi), Linux (appimage,deb). Output goes to `src-tauri/target/release/bundle/...`. The bundle is small — **no model inside**; the brain is downloaded on first run. See the `macos-signing-notarization` memory for signing/notarization details (Developer ID `6G2X3HSD2S`, app id `com.xaghoul-games.project-spy`); the key non-obvious gotcha is that Tauri signs+notarizes the `.app` but only *signs* the `.dmg`, so the workflow notarizes+staples the dmg itself.

## Env vars

| Var | Where | Effect |
|-----|-------|--------|
| `SPY_PORT` / `SPY_HOST` | Rust server | bind address (default `8787` / `127.0.0.1`) |
| `SPY_BRAIN` | `serve` example | auto-load a brain id on startup |
| `SPY_FAKE_RAM_BYTES` | Rust server | override reported RAM to exercise the memory-fit warning |
| `SPY_BASE_URL` | Vite (web-only dev) | LM Studio proxy target |
| `VITE_SPY_BACKEND` | Vite (bundled app) | inference server base (default `http://127.0.0.1:8787`) |

## Conventions worth preserving

- Keep the engine pure-referee: never let the model's own claim decide points; always validate (contradictions vs the statement log, pressure points vs triggers). The `claimedMove` vs `move` distinction in `TurnResult` exists precisely to surface when the model's claimed move was downgraded.
- The model returns JSON; the extraction is defensive (`extractJson`). If you change the judgment schema in `types.ts`/`prompts.ts`, update both sides.
- Gemma has no system role — `build_gemma_prompt` folds it into the first user turn. Don't try to pass a real system message.