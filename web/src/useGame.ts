import { useCallback, useRef, useState } from "react";
import { GameEngine, type GameSnapshot } from "./engine/engine";
import { LocalAnthropicClient } from "./engine/llm";
import { CASES } from "./engine/cases";
import type { CaseFile, JudgeOutcome, TurnResult } from "./engine/types";

export interface Entry {
  id: number;
  kind: "spy" | "player" | "system";
  text: string;
  tell?: string;
  result?: TurnResult;
}

export type Phase = "setup" | "playing";
export type Outcome = "won" | "lost" | "overthrown" | null;

export interface GameApi {
  phase: Phase;
  caseFile: CaseFile | null;
  entries: Entry[];
  snapshot: GameSnapshot | null;
  busy: boolean;
  error: string | null;
  outcome: Outcome;
  judgeVerdict: JudgeOutcome | null;
  start: (caseId: string, model: string, startResolve: number) => Promise<void>;
  send: (text: string) => Promise<void>;
  giveUp: () => void;
  reset: () => void;
}

export function useGame(): GameApi {
  const engineRef = useRef<GameEngine | null>(null);
  const idRef = useRef(0);

  const [phase, setPhase] = useState<Phase>("setup");
  const [caseFile, setCaseFile] = useState<CaseFile | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [judgeVerdict, setJudgeVerdict] = useState<JudgeOutcome | null>(null);

  const nextId = () => ++idRef.current;
  const add = (e: Omit<Entry, "id">) => setEntries((xs) => [...xs, { ...e, id: nextId() }]);

  const start = useCallback(async (caseId: string, model: string, startResolve: number) => {
    const cf = CASES[caseId];
    if (!cf) {
      setError(`Unknown case '${caseId}'`);
      return;
    }
    const engine = new GameEngine(cf, new LocalAnthropicClient({ model }), { startResolve });
    engineRef.current = engine;
    setCaseFile(cf);
    setEntries([]);
    setOutcome(null);
    setError(null);
    setPhase("playing");
    setBusy(true);
    setSnapshot(engine.snapshot());
    try {
      const r = await engine.open();
      add({ kind: "spy", text: r.speech, tell: r.tell, result: r });
      setSnapshot(engine.snapshot());
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const send = useCallback(async (text: string) => {
    const engine = engineRef.current;
    if (!engine || busy || outcome) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    add({ kind: "player", text: trimmed });
    setBusy(true);
    setError(null);
    try {
      const r = await engine.submit(trimmed);
      add({ kind: "spy", text: r.speech, tell: r.tell, result: r });
      setSnapshot(engine.snapshot());
      if (r.confessed) {
        // The spy broke — but was the confession earned legitimately? The Judge
        // reviews the transcript before the win is recorded. busy stays true.
        add({ kind: "system", text: "The spy has confessed. The Judge reviews the interrogation…" });
        let verdict: JudgeOutcome | null = null;
        try {
          verdict = await engine.judge();
        } catch (e) {
          // A Judge failure must not steal a hard-won confession; default to upheld.
          verdict = {
            legitimate: true,
            overturned: false,
            reasoning: `The Judge could not be convened (${errMsg(e)}); the confession stands.`,
            threateningTurns: [],
          };
        }
        setJudgeVerdict(verdict);
        setOutcome(verdict.overturned ? "overthrown" : "won");
        add({ kind: "system", text: verdict.reasoning });
      }
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }, [busy, outcome]);

  const giveUp = useCallback(() => {
    if (outcome) return;
    setOutcome("lost");
    add({ kind: "system", text: "You walked away. The spy kept the secret." });
  }, [outcome]);

  const reset = useCallback(() => {
    engineRef.current = null;
    setPhase("setup");
    setCaseFile(null);
    setEntries([]);
    setSnapshot(null);
    setOutcome(null);
    setJudgeVerdict(null);
    setError(null);
    setBusy(false);
  }, []);

  return {
    phase,
    caseFile,
    entries,
    snapshot,
    busy,
    error,
    outcome,
    judgeVerdict,
    start,
    send,
    giveUp,
    reset,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
