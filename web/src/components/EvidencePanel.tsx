import type { GameSnapshot } from "../engine/engine";
import type { CaseFile } from "../engine/types";

export function EvidencePanel({
  caseFile,
  snapshot,
}: {
  caseFile: CaseFile;
  snapshot: GameSnapshot;
}) {
  const hit = new Set(snapshot.pressurePointsHit);
  return (
    <>
      <div className="panel evidence">
        <h3>Leads</h3>
        {snapshot.leads.length === 0 ? (
          <div className="empty">Nothing to pull on yet. Get them talking.</div>
        ) : (
          <div className="leads-scroll">
            <div className="leads-hint">Loose threads worth pushing on:</div>
            <ul className="leads">
              {snapshot.leads.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="panel">
        <h3>Pressure Points</h3>
        <ul className="pp-list">
          {caseFile.pressurePoints.map((p) => {
            const found = hit.has(p.id);
            return (
              <li key={p.id} className={found ? "hit" : ""}>
                <span className="pp-dot" />
                {found ? p.label : "????"}
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}
