// Shared types for the interrogation engine. Mirrors the Python reference in
// ../../../spyengine. The app code is the referee; the model only acts.

export interface Secret {
  id: string;
  prompt: string; // human description: "the city where the meeting is"
  answer: string; // the word the spy must be made to confess
}

export interface PressurePoint {
  id: string; // matches the model's pressurePointHit value
  label: string; // short name for the debrief
  description: string; // what the player must do/say to hit it
  tell: string; // hint the spy may leak when probed near it
  triggers: string[]; // code-side backstop terms (regex/substring)
}

export interface CaseFile {
  id: string;
  spyName: string;
  summary: string; // player-facing briefing (NOT the spy's cover story)
  persona: string;
  coverPremise: string;
  secret: Secret;
  trueFacts: string[];
  falseFacts: string[];
  pressurePoints: PressurePoint[];
  threads: string[];
}

export type PlayerMove =
  | "vague_threat"
  | "smalltalk"
  | "specific_pressure"
  | "contradiction"
  | "pressure_point";

export type StrainTier =
  | "composed"
  | "guarded"
  | "rattled"
  | "breaking"
  | "confessed";

// The model's per-turn judgment (validated by the engine before it counts).
export interface Judgment {
  speech: string;
  tell: string;
  player_move: string;
  pressure_point_hit: string;
  contradiction_of: string | null;
  new_statements: string[];
  threads: string[];
}

export interface TurnResult {
  speech: string;
  tell: string;
  resolve: number;
  tier: StrainTier;
  delta: number;
  move: PlayerMove;
  claimedMove: string;
  pressurePointHit: string; // validated id or "none"
  contradictionGranted: boolean;
  confessed: boolean;
  notes: string[];
  threads: string[]; // probeable leads the spy dropped this turn
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// One adjudicated turn, for the Judge to review. `player` is null for the
// spy's unprompted opening statement (no interrogator line that turn).
export interface TurnRecord {
  player: string | null;
  move: PlayerMove;
  speech: string;
}

// The Judge's raw model output (validated by the engine before it counts).
export interface JudgeVerdict {
  legitimate: boolean;
  threatening_turns: string[]; // exact player snippets the Judge cites as threats
  reasoning: string;
}

// The final ruling after the engine corroborates the cited threats against
// the real transcript.
export interface JudgeOutcome {
  legitimate: boolean; // true = confession stands
  overturned: boolean; // true = threats invalidated the confession
  reasoning: string;
  threateningTurns: string[]; // only the cited snippets that actually verify
}
