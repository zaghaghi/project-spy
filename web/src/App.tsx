import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useGame } from "./useGame";
import { useServerStatus } from "./useServerStatus";
import { CASES, CASE_IDS } from "./engine/cases";
import { StrainMeter } from "./components/StrainMeter";
import { EvidencePanel } from "./components/EvidencePanel";
import { Transcript } from "./components/Transcript";
import { StartupGate } from "./components/StartupGate";
import { BrainSelect } from "./components/BrainSelect";

export default function App() {
  const game = useGame();
  const status = useServerStatus();
  const [debug, setDebug] = useState(false);
  // Flow: pick the case, then pick/upload the brain, then auto-begin.
  const [step, setStep] = useState<"case" | "brain">("case");
  const [caseId, setCaseId] = useState(CASE_IDS[0]);
  const [difficulty, setDifficulty] = useState(100);
  // True between clicking "download/load" and the server reporting progress.
  const [pendingLoad, setPendingLoad] = useState(false);
  const [loadRequested, setLoadRequested] = useState(false);
  const startedRef = useRef(false);
  const phase = status?.phase;

  useEffect(() => {
    if (phase && phase !== "idle") setPendingLoad(false);
  }, [phase]);

  // Once the chosen brain is ready (after an explicit pick this round), begin.
  useEffect(() => {
    if (step === "brain" && phase === "ready" && loadRequested && !startedRef.current) {
      startedRef.current = true;
      game.start(caseId, status!.modelName, difficulty);
    }
  }, [step, phase, loadRequested, caseId, difficulty, game, status]);

  const newGame = () => {
    game.reset();
    startedRef.current = false;
    setLoadRequested(false);
    setStep("case");
  };

  let screen;
  if (game.phase === "playing") {
    screen = <Game game={game} debug={debug} setDebug={setDebug} onNewGame={newGame} />;
  } else if (step === "case") {
    screen = (
      <CaseSelect
        caseId={caseId}
        setCaseId={setCaseId}
        difficulty={difficulty}
        setDifficulty={setDifficulty}
        debug={debug}
        setDebug={setDebug}
        onNext={() => setStep("brain")}
      />
    );
  } else if (!status) {
    screen = <StartupGate status={null} />;
  } else if (phase === "downloading" || phase === "loading" || pendingLoad || (phase === "ready" && loadRequested)) {
    screen = <StartupGate status={status} />;
  } else {
    // idle, error, or ready-but-not-yet-confirmed: let the player pick a brain
    screen = (
      <BrainSelect
        spyName={CASES[caseId].spyName}
        onLoading={() => {
          setPendingLoad(true);
          setLoadRequested(true);
        }}
        onBack={() => setStep("case")}
        serverError={phase === "error" ? status.error : undefined}
      />
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          PROJECT SPY <small>// interrogation</small>
        </div>
        {game.phase === "playing" && game.caseFile && (
          <div className="objective">
            Make <b>{game.caseFile.spyName}</b> confess <b>{game.caseFile.secret.prompt}</b>.
          </div>
        )}
      </header>
      {screen}
    </div>
  );
}

function CaseSelect({
  caseId,
  setCaseId,
  difficulty,
  setDifficulty,
  debug,
  setDebug,
  onNext,
}: {
  caseId: string;
  setCaseId: (s: string) => void;
  difficulty: number;
  setDifficulty: (n: number) => void;
  debug: boolean;
  setDebug: (b: boolean) => void;
  onNext: () => void;
}) {
  const cf = CASES[caseId];
  return (
    <div className="setup">
      <div className="panel">
        <p>
          You are the interrogator. The spy across the table is hiding one secret — and you
          already know what it is. Your job is to <b>break their will</b> until they say it out
          loud. Catch them in contradictions, find what they can't bear to talk about, and apply
          pressure that actually lands. Empty threats only stiffen their resolve.
        </p>

        <div className="field">
          <label>Case</label>
          <select value={caseId} onChange={(e) => setCaseId(e.target.value)}>
            {CASE_IDS.map((id) => (
              <option key={id} value={id}>
                {CASES[id].spyName} — {id}
              </option>
            ))}
          </select>
          <div className="case-blurb">{cf.summary}</div>
        </div>

        <div className="field">
          <label>Difficulty (starting resolve)</label>
          <select value={String(difficulty)} onChange={(e) => setDifficulty(Number(e.target.value))}>
            <option value="70">Soft (70)</option>
            <option value="100">Standard (100)</option>
            <option value="140">Hardened (140)</option>
          </select>
        </div>

        <div className="row" style={{ justifyContent: "space-between", marginTop: 20 }}>
          <label className="toggle">
            <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} />
            Show referee scoring
          </label>
          <button className="primary" onClick={onNext}>
            Next: recover the brain →
          </button>
        </div>
      </div>
    </div>
  );
}

function Game({
  game,
  debug,
  setDebug,
  onNewGame,
}: {
  game: ReturnType<typeof useGame>;
  debug: boolean;
  setDebug: (b: boolean) => void;
  onNewGame: () => void;
}) {
  const [draft, setDraft] = useState("");
  if (!game.caseFile || !game.snapshot) return null;

  const submit = () => {
    if (!draft.trim() || game.busy || game.outcome) return;
    game.send(draft);
    setDraft("");
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="stage">
      <div className="left">
        <Transcript
          entries={game.entries}
          caseFile={game.caseFile}
          busy={game.busy}
          debug={debug}
        />

        {game.outcome ? (
          <Debrief game={game} onNewGame={onNewGame} />
        ) : (
          <div className="composer">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
              placeholder="Press them… (Enter to send, Shift+Enter for a new line)"
              disabled={game.busy}
              autoFocus
            />
            <button className="primary" onClick={submit} disabled={game.busy || !draft.trim()}>
              Send
            </button>
          </div>
        )}
        {game.error && <div className="error">{game.error}</div>}
      </div>

      <div className="right">
        <StrainMeter snapshot={game.snapshot} debug={debug} />
        <EvidencePanel caseFile={game.caseFile} snapshot={game.snapshot} />
        <div className="panel">
          <label className="toggle" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} />
            Referee scoring
          </label>
          {!game.outcome && (
            <button className="ghost" style={{ width: "100%" }} onClick={game.giveUp}>
              Give up
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Debrief({ game, onNewGame }: { game: ReturnType<typeof useGame>; onNewGame: () => void }) {
  if (!game.caseFile || !game.snapshot) return null;
  const won = game.outcome === "won";
  const hit = new Set(game.snapshot.pressurePointsHit);
  return (
    <div className="composer">
      <div className="panel debrief" style={{ width: "100%" }}>
        <div className={`verdict ${won ? "won" : "lost"}`}>
          {won ? "CONFESSION EXTRACTED" : "THEY KEPT THE SECRET"}
        </div>
        <div className="secret">
          {won
            ? `${game.caseFile.spyName} broke after ${game.snapshot.turns} turns. The answer was ${game.caseFile.secret.answer}.`
            : `The answer was ${game.caseFile.secret.answer}. You'll have to come back harder.`}
        </div>
        <ul className="pp-list" style={{ display: "inline-block", textAlign: "left" }}>
          {game.caseFile.pressurePoints.map((p) => (
            <li key={p.id} className={hit.has(p.id) ? "hit" : ""}>
              <span className="pp-dot" />
              {p.label}
            </li>
          ))}
        </ul>
        <div style={{ marginTop: 16 }}>
          <button className="primary" onClick={onNewGame}>
            New interrogation
          </button>
        </div>
      </div>
    </div>
  );
}
