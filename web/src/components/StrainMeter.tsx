import type { GameSnapshot } from "../engine/engine";
import type { StrainTier } from "../engine/types";

const ORDER: StrainTier[] = ["composed", "guarded", "rattled", "breaking", "confessed"];

const COLOR: Record<StrainTier, string> = {
  composed: "#6fbf73",
  guarded: "#cdbb4a",
  rattled: "#e0a13c",
  breaking: "#d9534f",
  confessed: "#d9534f",
};

const HINT: Record<StrainTier, string> = {
  composed: "Cool and bored. Nothing you've said has landed.",
  guarded: "Clipped and careful. Something got through.",
  rattled: "Defensive, over-explaining. The cracks are showing.",
  breaking: "Barely holding. One more good push.",
  confessed: "It's over. They told you everything.",
};

export function StrainMeter({ snapshot, debug }: { snapshot: GameSnapshot; debug: boolean }) {
  const tier = snapshot.tier;
  const idx = ORDER.indexOf(tier);
  const filled = Math.max(0, 4 - idx); // drains left-to-right as resolve falls
  const color = COLOR[tier];
  return (
    <div className="panel strain">
      <h3>Spy's Resolve</h3>
      <div className="tier" style={{ color }}>
        {tier}
      </div>
      <div className="pips">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className={"pip" + (i < filled ? " on" : "")}
            style={i < filled ? { background: color } : undefined}
          />
        ))}
      </div>
      <div className="hint">{HINT[tier]}</div>
      {debug && <div className="raw">resolve {snapshot.resolve} · turn {snapshot.turns}</div>}
    </div>
  );
}
