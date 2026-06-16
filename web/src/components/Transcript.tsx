import { useEffect, useRef } from "react";
import type { Entry } from "../useGame";
import type { CaseFile, TurnResult } from "../engine/types";

function RefLine({ r }: { r: TurnResult }) {
  const bits: React.ReactNode[] = [];
  if (r.delta !== 0) {
    const cls = r.delta < 0 ? "delta-down" : "delta-up";
    bits.push(
      <span key="d" className={cls}>
        {r.delta > 0 ? `+${r.delta}` : r.delta} resolve
      </span>,
    );
  }
  bits.push(<span key="m"> · {r.move}</span>);
  if (r.pressurePointHit !== "none")
    bits.push(
      <span key="p" className="hit"> · pressure point: {r.pressurePointHit}</span>,
    );
  if (r.contradictionGranted) bits.push(<span key="c" className="hit"> · contradiction caught</span>);
  return <div className="ref">{bits}</div>;
}

export function Transcript({
  entries,
  caseFile,
  busy,
  debug,
}: {
  entries: Entry[];
  caseFile: CaseFile;
  busy: boolean;
  debug: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries, busy]);

  return (
    <div className="transcript">
      {entries.map((e) => (
        <div key={e.id} className={`entry ${e.kind}`}>
          <div className="who">
            {e.kind === "spy" ? caseFile.spyName : e.kind === "player" ? "You" : "—"}
          </div>
          {e.tell && <div className="tell">{e.tell}</div>}
          <div className="body">{e.text}</div>
          {debug && e.result && <RefLine r={e.result} />}
        </div>
      ))}
      {busy && <div className="typing">{caseFile.spyName} is considering you…</div>}
      <div ref={endRef} />
    </div>
  );
}
