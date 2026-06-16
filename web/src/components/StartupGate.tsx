import type { ServerStatus } from "../engine/llm";

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function StartupGate({ status }: { status: ServerStatus | null }) {
  // null => sidecar not reachable yet
  const phase = status?.phase ?? "connecting";
  const pct = status ? Math.round(status.progress * 100) : 0;

  const heading: Record<string, string> = {
    connecting: "Powering up the interrogation rig…",
    idle: "Awaiting a brain…",
    downloading: "Uploading brain tissue…",
    loading: "Spinning up the cortex…",
    error: "The upload failed",
    ready: "Ready",
  };

  const showBar = phase === "downloading";

  return (
    <div className="setup">
      <div className="panel startup">
        <div className="dossier">CLASSIFIED // BRIEFING IN PREPARATION</div>
        <h2>{heading[phase] ?? "Preparing…"}</h2>

        {showBar && (
          <>
            <div className="bar">
              <div className="bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="bar-meta">
              <span>{pct}%</span>
              <span>
                {fmtBytes(status!.downloadedBytes)} / {fmtBytes(status!.totalBytes)}
              </span>
            </div>
            <p className="startup-note">
              First run only — the model is cached for next time.
            </p>
          </>
        )}

        {!showBar && phase !== "error" && (
          <div className="spinner-row">
            <span className="spinner" />
            <span>{status?.message ?? "Waiting for the local model server…"}</span>
          </div>
        )}

        {phase === "error" && (
          <div className="error" style={{ marginTop: 12 }}>
            {status?.error ?? "The model could not be prepared."}
            <p className="startup-note">
              The app will keep retrying. Check the server logs if this persists.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
