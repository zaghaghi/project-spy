import { useEffect, useState } from "react";
import { fetchBrains, loadBrain, type Brain } from "../engine/llm";

function fmtGB(n: number): string {
  return `${(n / 1e9).toFixed(1)} GB`;
}

// Rough working-set estimate: model weights in (unified) memory + headroom for
// the KV cache and runtime.
const HEADROOM = 1.5e9;

type Fit = { level: "ok" | "tight" | "over"; note: string };

function fitFor(brain: Brain, ram: number): Fit {
  const need = brain.sizeBytes + HEADROOM;
  if (ram <= 0) return { level: "ok", note: "" };
  if (need > ram) {
    return {
      level: "over",
      note: `This brain (${fmtGB(brain.sizeBytes)}) is bigger than your machine's memory (${fmtGB(
        ram,
      )}). It'll spill onto disk and think at a glacial — possibly cryogenic — pace. Load it only if you're feeling patient, or grab the smaller scan.`,
    };
  }
  if (need > 0.75 * ram) {
    return {
      level: "tight",
      note: `Cozy fit — this brain will nearly fill your ${fmtGB(
        ram,
      )} of memory, so expect the spy to be a slow, sweaty thinker. The smaller scan is sprightlier.`,
    };
  }
  return { level: "ok", note: "" };
}

export function BrainSelect({
  spyName,
  onLoading,
  onBack,
  serverError,
}: {
  spyName: string;
  onLoading: () => void;
  onBack?: () => void;
  serverError?: string;
}) {
  const [brains, setBrains] = useState<Brain[] | null>(null);
  const [ram, setRam] = useState(0);
  const [selected, setSelected] = useState<string>("");
  const [error, setError] = useState<string | null>(serverError ?? null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchBrains()
      .then((cat) => {
        setBrains(cat.brains);
        setRam(cat.systemMemoryBytes);
        setSelected(cat.brains[0]?.id ?? "");
      })
      .catch((e) => setError(String(e)));
  }, []);

  const chosen = brains?.find((b) => b.id === selected);
  const fit = chosen ? fitFor(chosen, ram) : null;

  const upload = async () => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      await loadBrain(selected);
      onLoading(); // hand off to the progress gate
    } catch (e) {
      setError(String(e));
      setSubmitting(false);
    }
  };

  return (
    <div className="setup">
      <div className="panel">
        <div className="dossier">CLASSIFIED // ASSET RECOVERY</div>
        <h2 style={{ marginTop: 4 }}>The spy is dead.</h2>
        <p>
          Agent <b>{spyName}</b> died in custody before talking. But we reached the body in time
          and <b>imaged the brain</b>. What you load into the interrogation rig is a
          reconstruction of that mind — so choose your fidelity. A coarser scan is quick but
          fragile; a deeper scan gives you a sharper, more stubborn ghost to break.
        </p>

        {error && <div className="error">{error}</div>}

        {!brains ? (
          <div className="spinner-row" style={{ marginTop: 16 }}>
            <span className="spinner" /> <span>Locating recovered scans…</span>
          </div>
        ) : (
          <>
            <div className="field">
              <label>Brain scan</label>
              <select value={selected} onChange={(e) => setSelected(e.target.value)}>
                {brains.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label} — {fmtGB(b.sizeBytes)}
                    {b.downloaded ? " ✓ on disk" : ""}
                  </option>
                ))}
              </select>
              {chosen && <div className="case-blurb">{chosen.blurb}</div>}
            </div>

            {fit && fit.level !== "ok" && (
              <div className={`mem-warn ${fit.level}`}>
                <span className="mem-warn-icon">{fit.level === "over" ? "☠" : "⚠"}</span>
                <span>{fit.note}</span>
              </div>
            )}

            <div className="row" style={{ justifyContent: "space-between", marginTop: 20 }}>
              {onBack ? (
                <button className="ghost" onClick={onBack} disabled={submitting}>
                  ← Back
                </button>
              ) : (
                <span />
              )}
              <button className="primary" onClick={upload} disabled={submitting || !selected}>
                {fit?.level === "over"
                  ? chosen?.downloaded
                    ? "Load it anyway"
                    : "Download it anyway"
                  : chosen?.downloaded
                    ? "Load spy brain"
                    : "Download spy brain"}
              </button>
            </div>
            {chosen && !chosen.downloaded && (
              <p className="startup-note">
                First time only — {fmtGB(chosen.sizeBytes)} is downloaded once and kept for later.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
