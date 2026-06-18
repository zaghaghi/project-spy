// The game engine — the referee and source of truth. Owns the case file, the
// hidden resolve number, the scoring math, the statement log, tier derivation,
// and the win check. The model only acts and classifies; every points-bearing
// claim it makes is validated here before it counts.

import { LocalAnthropicClient } from "./llm";
import {
  buildJudgeSystem,
  buildJudgeTranscript,
  buildSystem,
  buildTurnPayload,
  OPENING_INSTRUCTION,
} from "./prompts";
import type {
  CaseFile,
  ChatMessage,
  Judgment,
  JudgeOutcome,
  JudgeVerdict,
  PlayerMove,
  StrainTier,
  TurnRecord,
  TurnResult,
} from "./types";

export const DRAIN: Record<PlayerMove, number> = {
  vague_threat: +5,
  smalltalk: 0,
  specific_pressure: -10,
  contradiction: -20,
  pressure_point: -30,
};

export const START_RESOLVE = 100;

const TIERS: Array<[number, StrainTier]> = [
  [70, "composed"],
  [40, "guarded"],
  [11, "rattled"],
  [1, "breaking"],
];

export function tierFor(resolve: number): StrainTier {
  if (resolve <= 0) return "confessed";
  for (const [floor, name] of TIERS) {
    if (resolve >= floor) return name;
  }
  return "breaking";
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
}

// A usable spoken line: a real string, not blank, not just punctuation/silence.
function usableSpeech(s: unknown): boolean {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (!t) return false;
  if (/^[.\-—\s…]+$/.test(t)) return false; // "...", "---", ellipsis, silence
  return true;
}

// Lightweight similarity (Sørensen–Dice over word bigrams) to approximate the
// Python difflib ratio used for fuzzy contradiction matching.
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ma = bigrams(a);
  const mb = bigrams(b);
  let overlap = 0;
  for (const [g, n] of ma) {
    const o = mb.get(g);
    if (o) overlap += Math.min(n, o);
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

const EMPTY_JUDGMENT: Judgment = {
  speech: "",
  tell: "",
  player_move: "smalltalk",
  pressure_point_hit: "none",
  contradiction_of: null,
  new_statements: [],
  threads: [],
};

// Last-resort in-character lines, used only when the model fails to produce a
// usable reply even after the retry nudge. Never a bare "..." — the spy stays
// present and detained, just stonewalling.
const STONEWALL = "I've got nothing to say to that.";
const STONEWALL_OPEN =
  "Ask me whatever you want. I've been through this before — I've got nothing to hide.";

export interface GameSnapshot {
  resolve: number;
  tier: StrainTier;
  statements: string[];
  leads: string[];
  pressurePointsHit: string[];
  turns: number;
  confessed: boolean;
}

export class GameEngine {
  readonly case: CaseFile;
  private client: LocalAnthropicClient;
  private system: string;
  private lenientContradictions: boolean;

  resolve: number;
  statements: string[] = [];
  leads: string[] = [];
  pressurePointsHit: string[] = [];
  history: ChatMessage[] = [];
  turns = 0;
  confessed = false;
  records: TurnRecord[] = []; // adjudicated turn log, for The Judge

  constructor(
    caseFile: CaseFile,
    client: LocalAnthropicClient,
    opts: { startResolve?: number; lenientContradictions?: boolean } = {},
  ) {
    this.case = caseFile;
    this.client = client;
    this.system = buildSystem(caseFile);
    this.lenientContradictions = opts.lenientContradictions ?? true;
    this.resolve = opts.startResolve ?? START_RESOLVE;
  }

  get tier(): StrainTier {
    return tierFor(this.resolve);
  }

  snapshot(): GameSnapshot {
    return {
      resolve: this.resolve,
      tier: this.tier,
      statements: [...this.statements],
      leads: [...this.leads],
      pressurePointsHit: [...this.pressurePointsHit],
      turns: this.turns,
      confessed: this.confessed,
    };
  }

  async open(): Promise<TurnResult> {
    const judgment = await this.ask(OPENING_INSTRUCTION, false);
    const speech = judgment.speech || STONEWALL_OPEN;
    this.logStatements(judgment.new_statements);
    this.logLeads(judgment.threads);
    this.history.push({ role: "assistant", content: speech });
    const shown = this.guardSecret(speech);
    this.records.push({ player: null, move: "smalltalk", speech: shown });
    return {
      speech: shown,
      tell: judgment.tell || "",
      resolve: this.resolve,
      tier: this.tier,
      delta: 0,
      move: "smalltalk",
      claimedMove: "smalltalk",
      pressurePointHit: "none",
      contradictionGranted: false,
      confessed: false,
      notes: [],
      threads: judgment.threads ?? [],
    };
  }

  async submit(playerText: string): Promise<TurnResult> {
    if (this.confessed) throw new Error("The spy has already confessed; the game is over.");

    this.turns += 1;
    const judgment = await this.ask(playerText, true);
    const notes: string[] = [];

    const claimedMove = judgment.player_move || "smalltalk";
    let move: PlayerMove = (claimedMove in DRAIN ? claimedMove : "smalltalk") as PlayerMove;
    if (!(claimedMove in DRAIN)) notes.push(`unknown move '${claimedMove}' -> smalltalk`);

    let contradictionGranted = false;
    if (move === "contradiction") {
      if (this.validateContradiction(judgment.contradiction_of)) {
        contradictionGranted = true;
      } else {
        move = this.lenientContradictions ? "specific_pressure" : "smalltalk";
        notes.push("unverified contradiction -> downgraded");
      }
    }

    let delta = DRAIN[move];

    // Pressure points: trust neither model nor phrasing alone. A hit counts if
    // EITHER the model flags a valid point OR the player's text matches its
    // triggers. Scores -30 only on first hit.
    const ppIds = this.case.pressurePoints.map((p) => p.id);
    const ppClaim = (judgment.pressure_point_hit || "none").trim();
    const candidates: string[] = [];
    if (ppClaim !== "none") {
      if (ppIds.includes(ppClaim)) candidates.push(ppClaim);
      else notes.push(`unknown pressure point '${ppClaim}' ignored`);
    }
    for (const pid of this.detectPressurePoints(playerText)) {
      if (!candidates.includes(pid)) {
        candidates.push(pid);
        if (pid !== ppClaim) notes.push(`pressure point '${pid}' caught by referee triggers`);
      }
    }

    let pressurePointHit = "none";
    const newPp = candidates.find((p) => !this.pressurePointsHit.includes(p));
    if (newPp) {
      pressurePointHit = newPp;
      this.pressurePointsHit.push(newPp);
      move = "pressure_point";
      delta = DRAIN.pressure_point;
    } else if (candidates.length) {
      notes.push(`pressure point(s) ${candidates.join(", ")} already hit; no bonus`);
    }

    this.resolve = clamp(this.resolve + delta, 0, 100);
    this.logStatements(judgment.new_statements);
    this.logLeads(judgment.threads);

    let speech = judgment.speech || STONEWALL;
    let tell = judgment.tell || "";
    const confessed = this.resolve <= 0;

    if (confessed && !this.confessed) {
      this.confessed = true;
      const c = await this.elicitConfession(speech);
      speech = c.speech;
      tell = c.tell;
    }

    this.history.push({ role: "assistant", content: speech });

    const shown = confessed ? speech : this.guardSecret(speech);
    this.records.push({ player: playerText, move, speech: shown });

    return {
      speech: shown,
      tell,
      resolve: this.resolve,
      tier: this.tier,
      delta,
      move,
      claimedMove,
      pressurePointHit,
      contradictionGranted,
      confessed,
      notes,
      threads: judgment.threads ?? [],
    };
  }

  // -- model plumbing -----------------------------------------------------

  private injectedState() {
    return {
      resolve_tier: this.tier,
      turn: this.turns,
      statements_so_far: this.statements.slice(-12),
      pressure_points_already_hit: [...this.pressurePointsHit],
    };
  }

  private async ask(playerText: string, recordPlayer: boolean): Promise<Judgment> {
    const payload = buildTurnPayload(playerText, this.injectedState());
    const messages: ChatMessage[] = [...this.history, { role: "user", content: payload }];
    let raw = await this.client.messagesJson<Partial<Judgment>>(this.system, messages);

    // Local models sometimes glitch: empty speech, a literal "..." pause, or
    // prose instead of JSON (messagesJson -> null). Nudge once and retry so the
    // player never gets a dead turn. The nudge is transient — never logged.
    if (!usableSpeech(raw?.speech)) {
      raw = await this.client.messagesJson<Partial<Judgment>>(
        this.system,
        [
          ...messages,
          {
            role: "user",
            content:
              "Reply THIS turn with a real line said aloud in character. Do not stay " +
              "silent, do not output \"...\" or an empty speech field, and do not claim " +
              "you can leave, demand a lawyer, or refuse to talk. You are detained and " +
              "must answer — resist through deflection or lies if you must, but SPEAK. " +
              "Return only the JSON object.",
          },
        ],
      );
    }

    if (recordPlayer) this.history.push({ role: "user", content: playerText });
    return { ...EMPTY_JUDGMENT, ...(raw ?? {}) };
  }

  // A recent window of the conversation, dropping older middle turns. Safe to
  // drop early turns because build_gemma_prompt folds the system text into the
  // first user turn of whatever messages it's given, so the system prompt
  // survives windowing. Used to keep the confession/Judge decodes off the
  // max-length full history — the trigger for the ggml_abort crash.
  private trimmedHistory(maxMessages: number): ChatMessage[] {
    if (this.history.length <= maxMessages) return [...this.history];
    return this.history.slice(this.history.length - maxMessages);
  }

  private async elicitConfession(defaultSpeech: string): Promise<{ speech: string; tell: string }> {
    const answer = this.case.secret.answer;
    const state = { ...this.injectedState(), resolve_tier: "confessed" };
    const directive =
      "Your resolve is gone. You finally break. In one or two sentences, " +
      `confess in character and say the words "${answer}" out loud as the answer ` +
      `to: ${this.case.secret.prompt}. Respond with only the JSON object; set ` +
      'player_move to "specific_pressure".';
    const payload = buildTurnPayload(directive, state);
    // Window the history: the engine guarantees the payoff below regardless of
    // what the model says, so the confession can't be broken by a shorter
    // context — and a shorter context keeps this decode off the max-length
    // history that was crashing llama.cpp mid-decode.
    const messages: ChatMessage[] = [...this.trimmedHistory(8), { role: "user", content: payload }];
    const raw = await this.client.messagesJson<Partial<Judgment>>(this.system, messages, {
      maxTokens: 320,
    });
    let speech = raw?.speech || defaultSpeech;
    const tell = raw?.tell || "(the fight goes out of them)";

    // The payoff cannot depend on a weak model cooperating.
    if (answer && !speech.toLowerCase().includes(answer.toLowerCase())) {
      speech = `${speech.trim()} ...Fine. It's ${answer}. ${answer} — that's what you came for.`;
    }
    return { speech, tell };
  }

  // -- The Judge ----------------------------------------------------------
  // A second agent rules whether the just-obtained confession was earned
  // legitimately or extracted by threats of violence/torture/blackmail. The
  // model only OPINES; the engine corroborates every cited threat against the
  // real transcript before any confession is overturned — a hallucinated
  // citation cannot steal a clean win. Mirrors validateContradiction.
  async judge(): Promise<JudgeOutcome> {
    const system = buildJudgeSystem(this.case);
    const transcript = buildJudgeTranscript(this.records);
    const raw = await this.client.messagesJson<Partial<JudgeVerdict>>(
      system,
      [{ role: "user", content: transcript }],
      { maxTokens: 350 },
    );

    const legitimate = raw?.legitimate !== false; // absent/ambiguous -> stands
    const reasoning =
      typeof raw?.reasoning === "string" && raw.reasoning.trim()
        ? raw.reasoning.trim()
        : legitimate
          ? "The interrogation was conducted within bounds. The confession stands."
          : "The interrogator crossed the line into coercion. The confession is void.";

    const cited = Array.isArray(raw?.threatening_turns)
      ? raw!.threatening_turns.filter((t) => typeof t === "string" && t.trim()).map((t) => t!.trim())
      : [];

    const verified = cited.filter((snippet) => this.verifyThreatCitation(snippet));
    const overturned = !legitimate && verified.length > 0;

    return {
      legitimate: !overturned,
      overturned,
      reasoning,
      threateningTurns: verified,
    };
  }

  /// Does a snippet the Judge cited as a threat actually appear in what the
  /// interrogator said? Fuzzy, same approach as contradiction validation.
  private verifyThreatCitation(snippet: string): boolean {
    const target = norm(snippet);
    if (!target) return false;
    for (const r of this.records) {
      if (r.player === null) continue;
      const s = norm(r.player);
      if (!s) continue;
      if (s.includes(target) || target.includes(s)) return true;
      if (similarity(target, s) >= 0.6) return true;
    }
    return false;
  }

  // -- referee helpers ----------------------------------------------------

  private logStatements(items: unknown): void {
    if (!Array.isArray(items)) return;
    for (const s of items) {
      if (typeof s === "string" && s.trim()) this.statements.push(s.trim());
    }
  }

  // Accumulate probeable leads (newest first, de-duplicated, capped).
  private logLeads(items: unknown): void {
    if (!Array.isArray(items)) return;
    const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
    for (const t of items) {
      if (typeof t !== "string" || !t.trim()) continue;
      const v = t.trim();
      if (!this.leads.some((l) => key(l) === key(v))) {
        this.leads.unshift(v);
      }
    }
    if (this.leads.length > 6) this.leads.length = 6;
  }

  private detectPressurePoints(playerText: string): string[] {
    const text = playerText || "";
    const hits: string[] = [];
    for (const p of this.case.pressurePoints) {
      for (const trig of p.triggers) {
        let matched: boolean;
        try {
          matched = new RegExp(trig, "i").test(text);
        } catch {
          matched = text.toLowerCase().includes(trig.toLowerCase());
        }
        if (matched) {
          hits.push(p.id);
          break;
        }
      }
    }
    return hits;
  }

  private validateContradiction(cited: string | null): boolean {
    if (!cited || typeof cited !== "string") return false;
    const target = norm(cited);
    if (!target) return false;
    for (const stmt of this.statements) {
      const s = norm(stmt);
      if (!s) continue;
      if (s.includes(target) || target.includes(s)) return true;
      if (similarity(target, s) >= 0.6) return true;
    }
    return false;
  }

  private guardSecret(speech: string): string {
    const answer = this.case.secret.answer;
    if (!answer) return speech;
    const pattern = new RegExp(answer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    return speech.replace(pattern, "—");
  }
}
