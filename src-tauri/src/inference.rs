// In-process inference via llama.cpp (the llama-cpp-2 crate). A "brain" (QAT GGUF)
// is downloaded from HuggingFace on demand, then loaded. All llama.cpp objects
// live on one dedicated worker thread (they aren't Sync); the async server talks
// to it over a channel. The persistent context keeps its KV cache warm across
// turns so only new tokens are decoded (prompt caching).

use std::io::{Read, Write};
use std::num::NonZeroU32;
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::sync::oneshot;

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::token::LlamaToken;

use crate::brains::{self, Brain};

const N_CTX: u32 = 8192;

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Idle,
    Downloading,
    Loading,
    Ready,
    Error,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub phase: Phase,
    pub model_ready: bool,
    pub model_name: String,
    pub progress: f32,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Status {
    fn idle() -> Self {
        Status {
            phase: Phase::Idle,
            model_ready: false,
            model_name: String::new(),
            progress: 0.0,
            downloaded_bytes: 0,
            total_bytes: 0,
            message: "No brain loaded".to_string(),
            error: None,
        }
    }
}

enum Msg {
    Load {
        brain_id: String,
    },
    Generate {
        system: Option<String>,
        messages: Vec<(String, String)>,
        max_tokens: usize,
        resp: oneshot::Sender<Result<String, String>>,
    },
}

#[derive(Clone)]
pub struct Engine {
    status: Arc<Mutex<Status>>,
    tx: Arc<Mutex<Option<Sender<Msg>>>>,
}

impl Engine {
    pub fn new() -> Self {
        Engine {
            status: Arc::new(Mutex::new(Status::idle())),
            tx: Arc::new(Mutex::new(None)),
        }
    }

    pub fn status(&self) -> Status {
        self.status.lock().unwrap().clone()
    }

    fn set(&self, f: impl FnOnce(&mut Status)) {
        let mut s = self.status.lock().unwrap();
        f(&mut s);
        s.model_ready = s.phase == Phase::Ready;
    }

    /// Spawn the worker thread. It waits idle until a brain is requested.
    pub fn start(&self) {
        let (tx, rx) = std::sync::mpsc::channel::<Msg>();
        *self.tx.lock().unwrap() = Some(tx);
        let me = self.clone();
        std::thread::Builder::new()
            .name("llama-worker".into())
            .spawn(move || me.worker(rx))
            .expect("failed to spawn llama worker");
    }

    /// Request that a brain be downloaded (if needed) and loaded.
    pub fn load(&self, brain_id: &str) -> Result<(), String> {
        let guard = self.tx.lock().unwrap();
        let tx = guard.as_ref().ok_or("engine not started")?;
        tx.send(Msg::Load {
            brain_id: brain_id.to_string(),
        })
        .map_err(|_| "worker gone".to_string())
    }

    /// One Anthropic-style turn -> reply text.
    pub async fn generate(
        &self,
        system: Option<&str>,
        messages: &[(String, String)],
        max_tokens: usize,
    ) -> Result<String, String> {
        let (resp_tx, resp_rx) = oneshot::channel();
        {
            let guard = self.tx.lock().unwrap();
            let tx = guard.as_ref().ok_or_else(|| "model not ready".to_string())?;
            tx.send(Msg::Generate {
                system: system.map(|s| s.to_string()),
                messages: messages.to_vec(),
                max_tokens,
                resp: resp_tx,
            })
            .map_err(|_| "worker gone".to_string())?;
        }
        resp_rx.await.map_err(|_| "worker dropped response".to_string())?
    }

    // -- worker thread -----------------------------------------------------

    fn worker(&self, rx: Receiver<Msg>) {
        let backend = match LlamaBackend::init() {
            Ok(b) => b,
            Err(e) => {
                self.set(|s| {
                    s.phase = Phase::Error;
                    s.message = "Backend init failed".into();
                    s.error = Some(e.to_string());
                });
                return;
            }
        };

        let mut pending: Option<String> = None;
        loop {
            // Determine the next brain to load.
            let brain_id = match pending.take() {
                Some(id) => id,
                None => match self.recv_until_load(&rx) {
                    Some(id) => id,
                    None => return, // channel closed
                },
            };

            let brain = match brains::find(&brain_id) {
                Some(b) => b,
                None => {
                    self.set(|s| {
                        s.phase = Phase::Error;
                        s.message = "Unknown brain".into();
                        s.error = Some(format!("no brain '{brain_id}'"));
                    });
                    continue;
                }
            };

            let model = match self.download_and_load(&backend, brain) {
                Ok(m) => m,
                Err(e) => {
                    self.set(|s| {
                        s.phase = Phase::Error;
                        s.message = "Failed to load brain".into();
                        s.error = Some(e);
                    });
                    continue;
                }
            };

            // Build the persistent context for this brain.
            let ctx_params = LlamaContextParams::default().with_n_ctx(NonZeroU32::new(N_CTX));
            let mut ctx = match model.new_context(&backend, ctx_params) {
                Ok(c) => c,
                Err(e) => {
                    self.set(|s| {
                        s.phase = Phase::Error;
                        s.message = "Context init failed".into();
                        s.error = Some(e.to_string());
                    });
                    continue;
                }
            };
            let mut cached: Vec<LlamaToken> = Vec::new();
            self.set(|s| {
                s.phase = Phase::Ready;
                s.message = format!("{} ready", brain.label);
                s.progress = 1.0;
                s.error = None;
            });

            // Serve turns until a reload is requested or the channel closes.
            loop {
                match rx.recv() {
                    Ok(Msg::Generate {
                        system,
                        messages,
                        max_tokens,
                        resp,
                    }) => {
                        let prompt = build_gemma_prompt(system.as_deref(), &messages);
                        let r = generate(&model, &mut ctx, &mut cached, &prompt, max_tokens);
                        let _ = resp.send(r);
                    }
                    Ok(Msg::Load { brain_id }) => {
                        pending = Some(brain_id);
                        break; // drop model+ctx, reload in the outer loop
                    }
                    Err(_) => return,
                }
            }
        }
    }

    /// Wait for a Load message, answering any stray Generate with an error.
    fn recv_until_load(&self, rx: &Receiver<Msg>) -> Option<String> {
        loop {
            match rx.recv() {
                Ok(Msg::Load { brain_id }) => return Some(brain_id),
                Ok(Msg::Generate { resp, .. }) => {
                    let _ = resp.send(Err("no brain loaded".to_string()));
                }
                Err(_) => return None,
            }
        }
    }

    fn download_and_load(
        &self,
        backend: &LlamaBackend,
        brain: &Brain,
    ) -> Result<LlamaModel, String> {
        let path = brain.path();
        if !path.exists() {
            self.download(brain)?;
        }

        self.set(|s| {
            s.phase = Phase::Loading;
            s.model_name = brain.label.to_string();
            s.message = "Spinning up the cortex…".into();
            s.progress = 1.0;
        });

        let params = LlamaModelParams::default().with_n_gpu_layers(999);
        LlamaModel::load_from_file(backend, &path, &params).map_err(|e| e.to_string())
    }

    fn download(&self, brain: &Brain) -> Result<(), String> {
        std::fs::create_dir_all(brains::cache_dir()).map_err(|e| e.to_string())?;
        self.set(|s| {
            s.phase = Phase::Downloading;
            s.model_name = brain.label.to_string();
            s.message = "Uploading brain tissue…".into();
            s.progress = 0.0;
            s.downloaded_bytes = 0;
            s.total_bytes = brain.size_bytes;
        });

        let client = reqwest::blocking::Client::builder()
            .timeout(None)
            .build()
            .map_err(|e| e.to_string())?;
        let mut resp = client
            .get(brain.resolve_url())
            .send()
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        let total = resp.content_length().unwrap_or(brain.size_bytes);

        let tmp = brain.path().with_extension("part");
        let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; 1 << 20];
        let mut downloaded: u64 = 0;
        loop {
            let n = resp.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            downloaded += n as u64;
            self.set(|s| {
                s.downloaded_bytes = downloaded;
                s.total_bytes = total;
                s.progress = if total > 0 {
                    downloaded as f32 / total as f32
                } else {
                    0.0
                };
            });
        }
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        std::fs::rename(&tmp, brain.path()).map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Generate a reply, reusing the warm KV cache. Only tokens past the longest
/// common prefix with the previous turn are decoded.
fn generate(
    model: &LlamaModel,
    ctx: &mut llama_cpp_2::context::LlamaContext,
    cached: &mut Vec<LlamaToken>,
    prompt: &str,
    max_tokens: usize,
) -> Result<String, String> {
    let tokens = model
        .str_to_token(prompt, AddBos::Always)
        .map_err(|e| format!("tokenize: {e}"))?;
    if tokens.len() as u32 >= N_CTX {
        return Err("prompt longer than context window".to_string());
    }

    let mut p = 0usize;
    let max_p = tokens.len().min(cached.len());
    while p < max_p && tokens[p] == cached[p] {
        p += 1;
    }
    if p == tokens.len() {
        p = tokens.len() - 1;
    }

    ctx.clear_kv_cache_seq(Some(0), Some(p as u32), None)
        .map_err(|e| e.to_string())?;

    let delta = &tokens[p..];
    let mut batch = LlamaBatch::new(delta.len().max(1), 1);
    let last = delta.len() - 1;
    for (i, tok) in delta.iter().enumerate() {
        batch
            .add(*tok, (p + i) as i32, &[0], i == last)
            .map_err(|e| e.to_string())?;
    }
    ctx.decode(&mut batch).map_err(|e| e.to_string())?;
    *cached = tokens;

    let mut n_cur = cached.len() as i32;
    let max_total = (n_cur + max_tokens as i32).min(N_CTX as i32 - 1);
    let mut sampler = LlamaSampler::chain_simple([
        LlamaSampler::top_k(40),
        LlamaSampler::top_p(0.95, 1),
        LlamaSampler::temp(0.8),
        LlamaSampler::dist(seed()),
    ]);
    let mut decoder = encoding_rs::UTF_8.new_decoder();
    let mut out = String::new();

    while n_cur < max_total {
        let token = sampler.sample(ctx, batch.n_tokens() - 1);
        sampler.accept(token);
        if model.is_eog_token(token) {
            break;
        }
        let piece = model
            .token_to_piece(token, &mut decoder, false, None)
            .map_err(|e| e.to_string())?;
        out.push_str(&piece);
        if let Some(idx) = out.find("<end_of_turn>").or_else(|| out.find("<start_of_turn>")) {
            out.truncate(idx);
            break;
        }

        cached.push(token);
        batch.clear();
        batch.add(token, n_cur, &[0], true).map_err(|e| e.to_string())?;
        n_cur += 1;
        ctx.decode(&mut batch).map_err(|e| e.to_string())?;
    }

    Ok(out.trim().to_string())
}

fn seed() -> u32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0)
}

/// Build a Gemma chat-format prompt. Gemma has no system role, so the system
/// text is folded into the first user turn. BOS is added by the tokenizer.
fn build_gemma_prompt(system: Option<&str>, messages: &[(String, String)]) -> String {
    let mut out = String::new();
    let sys = system.unwrap_or("").trim().to_string();
    let mut sys_used = false;
    for (role, content) in messages {
        if role == "assistant" {
            out.push_str("<start_of_turn>model\n");
            out.push_str(content.trim());
            out.push_str("<end_of_turn>\n");
        } else {
            out.push_str("<start_of_turn>user\n");
            if !sys.is_empty() && !sys_used {
                out.push_str(&sys);
                out.push_str("\n\n");
                sys_used = true;
            }
            out.push_str(content.trim());
            out.push_str("<end_of_turn>\n");
        }
    }
    if !sys.is_empty() && !sys_used {
        out.push_str("<start_of_turn>user\n");
        out.push_str(&sys);
        out.push_str("<end_of_turn>\n");
    }
    out.push_str("<start_of_turn>model\n");
    out
}
