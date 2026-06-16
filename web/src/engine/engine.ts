// The game engine — the referee and source of truth. Owns the case file, the
// hidden resolve number, the scoring math, the statement log, tier derivation,
// and the win check. The model only acts and classifies; every points-bearing
// claim it makes is validated here before it counts.

import { LocalAnthropicClient } from "./llm";
import { buildSystem, buildTurnPayload, OPENING_INSTRUCTION } from "./prompts";
import type {
  CaseFile,
  ChatMessage,
  Judgment,
  PlayerMove,
  StrainTier,
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
    const speech = judgment.speech || "...";
    this.logStatements(judgment.new_statements);
    this.logLeads(judgment.threads);
    this.history.push({ role: "assistant", content: speech });
    return {
      speech: this.guardSecret(speech),
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

    let speech = judgment.speech || "...";
    let tell = judgment.tell || "";
    const confessed = this.resolve <= 0;

    if (confessed && !this.confessed) {
      this.confessed = true;
      const c = await this.elicitConfession(speech);
      speech = c.speech;
      tell = c.tell;
    }

    this.history.push({ role: "assistant", content: speech });

    return {
      speech: confessed ? speech : this.guardSecret(speech),
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
    const raw = await this.client.messagesJson<Partial<Judgment>>(this.system, messages);
    if (recordPlayer) this.history.push({ role: "user", content: playerText });
    return { ...EMPTY_JUDGMENT, ...(raw ?? {}) };
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
    const messages: ChatMessage[] = [...this.history, { role: "user", content: payload }];
    const raw = await this.client.messagesJson<Partial<Judgment>>(this.system, messages);
    let speech = raw?.speech || defaultSpeech;
    const tell = raw?.tell || "(the fight goes out of them)";

    // The payoff cannot depend on a weak model cooperating.
    if (answer && !speech.toLowerCase().includes(answer.toLowerCase())) {
      speech = `${speech.trim()} ...Fine. It's ${answer}. ${answer} — that's what you came for.`;
    }
    return { speech, tell };
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
