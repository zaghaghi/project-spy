// The "spy brain" catalog: selectable QAT GGUF builds of gemma-4, downloaded
// from HuggingFace on demand. Bigger brain = a sharper, harder-to-break spy (and
// a heavier compute load), themed as the scan fidelity of a dead agent's mind.

use std::path::PathBuf;

use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Brain {
    pub id: &'static str,
    pub label: &'static str,
    pub blurb: &'static str,
    #[serde(skip)]
    pub repo: &'static str,
    pub file: &'static str,
    pub size_bytes: u64,
}

pub const CATALOG: &[Brain] = &[
    Brain {
        id: "partial",
        label: "Partial scan — E2B",
        blurb: "Fast to upload, but the memories are fragmented. Cracks under pressure. Runs on almost anything.",
        repo: "google/gemma-4-E2B-it-qat-q4_0-gguf",
        file: "gemma-4-E2B_q4_0-it.gguf",
        size_bytes: 3_350_000_000,
    },
    Brain {
        id: "full",
        label: "Full scan — E4B",
        blurb: "A clearer reconstruction. Sharper recall, more resistant to interrogation. Wants a roomier rig.",
        repo: "google/gemma-4-E4B-it-qat-q4_0-gguf",
        file: "gemma-4-E4B_q4_0-it.gguf",
        size_bytes: 5_150_000_000,
    },
];

/// Total physical RAM in bytes (for the memory-fit warning).
pub fn total_memory_bytes() -> u64 {
    // QA override to exercise the low-memory warning on any machine.
    if let Ok(v) = std::env::var("SPY_FAKE_RAM_BYTES") {
        if let Ok(n) = v.parse::<u64>() {
            return n;
        }
    }
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    sys.total_memory()
}

pub fn find(id: &str) -> Option<&'static Brain> {
    CATALOG.iter().find(|b| b.id == id)
}

/// Where downloaded brains are cached (persists across runs).
pub fn cache_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".project-spy")
        .join("brains")
}

impl Brain {
    pub fn path(&self) -> PathBuf {
        cache_dir().join(self.file)
    }
    pub fn is_downloaded(&self) -> bool {
        self.path().exists()
    }
    pub fn resolve_url(&self) -> String {
        format!("https://huggingface.co/{}/resolve/main/{}", self.repo, self.file)
    }
}

/// Catalog entry plus whether it's already on disk — for the /brains response.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrainListing {
    #[serde(flatten)]
    pub brain: Brain,
    pub downloaded: bool,
}

pub fn listing() -> Vec<BrainListing> {
    CATALOG
        .iter()
        .map(|b| BrainListing {
            brain: b.clone(),
            downloaded: b.is_downloaded(),
        })
        .collect()
}
