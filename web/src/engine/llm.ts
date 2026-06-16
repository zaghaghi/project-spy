// Client for a local Anthropic-compatible /v1/messages endpoint. In the bundled
// desktop app this is the in-process axum server in src-tauri (which proxies
// to llama-cpp-2 on Metal); the same client also works against LM Studio.
// Local models rarely honor a strict JSON mode, so we ask for raw JSON and
// extract it defensively.

import type { ChatMessage } from "./types";

export const DEFAULT_MODEL = "gemma-4-e2b";

// Where the inference server lives. The Tauri shell binds here; override for
// a remote/LM-Studio setup with VITE_SPY_BACKEND at build/dev time.
export const SIDECAR_BASE =
  (import.meta.env.VITE_SPY_BACKEND as string | undefined) || "http://127.0.0.1:8787";

export type ServerPhase = "idle" | "downloading" | "loading" | "ready" | "error";

export interface ServerStatus {
  phase: ServerPhase;
  modelReady: boolean;
  modelName: string;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  message: string;
  error?: string;
}

export interface Brain {
  id: string;
  label: string;
  blurb: string;
  file: string;
  sizeBytes: number;
  downloaded: boolean;
}

export interface BrainCatalog {
  systemMemoryBytes: number;
  brains: Brain[];
}

/** The catalog of downloadable "spy brains" plus this machine's total RAM. */
export async function fetchBrains(baseUrl: string = SIDECAR_BASE): Promise<BrainCatalog> {
  const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/brains`);
  if (!resp.ok) throw new LLMError(`brains: HTTP ${resp.status}`);
  return (await resp.json()) as BrainCatalog;
}

/** Ask the backend to download (if needed) and load a brain. */
export async function loadBrain(id: string, baseUrl: string = SIDECAR_BASE): Promise<void> {
  const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/load`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new LLMError((body as { error?: string }).error || `load: HTTP ${resp.status}`);
  }
}

export class LLMError extends Error {}

export interface LLMConfig {
  baseUrl?: string; // default: the local inference server
  model?: string;
  apiKey?: string;
}

/** Poll the local server's readiness/progress. Returns null if it's unreachable. */
export async function fetchStatus(baseUrl: string = SIDECAR_BASE): Promise<ServerStatus | null> {
  try {
    const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/health`);
    if (!resp.ok) return null;
    return (await resp.json()) as ServerStatus;
  } catch {
    return null;
  }
}

interface AnthropicResponse {
  type?: string;
  error?: unknown;
  content?: Array<{ type: string; text?: string }>;
}

export class LocalAnthropicClient {
  baseUrl: string;
  model: string;
  apiKey: string;

  constructor(cfg: LLMConfig = {}) {
    this.baseUrl = (cfg.baseUrl ?? SIDECAR_BASE).replace(/\/$/, "");
    this.model = cfg.model ?? DEFAULT_MODEL;
    this.apiKey = cfg.apiKey ?? "lm-studio";
  }

  async messages(
    system: string,
    messages: ChatMessage[],
    opts: { maxTokens?: number; temperature?: number } = {},
  ): Promise<string> {
    let resp: Response;
    try {
      resp = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: opts.maxTokens ?? 700,
          temperature: opts.temperature ?? 0.8,
          system,
          messages,
        }),
      });
    } catch (e) {
      throw new LLMError(
        `Cannot reach the model endpoint. Is LM Studio running with a model loaded? (${String(e)})`,
      );
    }

    const data = (await resp.json().catch(() => null)) as AnthropicResponse | null;
    if (!resp.ok || !data) {
      throw new LLMError(`HTTP ${resp.status} from endpoint: ${JSON.stringify(data)}`);
    }
    if (data.type === "error") {
      throw new LLMError(JSON.stringify(data.error));
    }
    return extractText(data);
  }

  async messagesJson<T = Record<string, unknown>>(
    system: string,
    messages: ChatMessage[],
    opts: { maxTokens?: number; temperature?: number } = {},
  ): Promise<T | null> {
    const text = await this.messages(system, messages, opts);
    return extractJson<T>(text);
  }
}

function extractText(data: AnthropicResponse): string {
  const parts = data.content ?? [];
  return parts
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("")
    .trim();
}

const FENCE = /```(?:json)?\s*([\s\S]*?)```/;

export function extractJson<T = Record<string, unknown>>(text: string): T | null {
  if (!text) return null;
  const candidates: string[] = [];
  const fenced = FENCE.exec(text);
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(text.trim());

  for (const c of candidates) {
    const obj = tryLoad<T>(c) ?? tryBalanced<T>(c);
    if (obj !== null) return obj;
  }
  return null;
}

function tryLoad<T>(s: string): T | null {
  try {
    const obj = JSON.parse(s);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as T) : null;
  } catch {
    return null;
  }
}

// Scan for the first balanced {...} object, ignoring braces inside strings.
function tryBalanced<T>(s: string): T | null {
  let start = s.indexOf("{");
  while (start !== -1) {
    let depth = 0;
    let inStr = false;
    let escape = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const obj = tryLoad<T>(s.slice(start, i + 1));
          if (obj !== null) return obj;
          break;
        }
      }
    }
    start = s.indexOf("{", start + 1);
  }
  return null;
}
