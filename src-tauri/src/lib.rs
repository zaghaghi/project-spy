//! Project Spy inference library: the in-process llama.cpp engine, the brain
//! catalog/downloader, and the localhost Anthropic-compatible server. Shared by
//! the Tauri binary and tests.

pub mod brains;
pub mod inference;
pub mod server;
