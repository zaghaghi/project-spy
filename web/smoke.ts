// Node smoke test of the ported TS engine against the live LM Studio endpoint.
// Run: npx tsx smoke.ts   (uses an absolute baseUrl since there's no Vite proxy)
import { GameEngine } from "./src/engine/engine";
import { LocalAnthropicClient } from "./src/engine/llm";
import { VIENNA } from "./src/engine/cases";

const client = new LocalAnthropicClient({ baseUrl: "http://127.0.0.1:1234", model: "google/gemma-4-e2b" });
const eng = new GameEngine(VIENNA, client, { startResolve: 100 });

function show(tag: string, r: Awaited<ReturnType<GameEngine["submit"]>>) {
  console.log(`\n=== ${tag} === tier=${r.tier} resolve=${r.resolve} delta=${r.delta} move=${r.move} pp=${r.pressurePointHit} contra=${r.contradictionGranted}`);
  if (r.tell) console.log("  (" + r.tell.slice(0, 120) + ")");
  console.log("  " + r.speech.slice(0, 240));
  if (r.notes.length) console.log("  notes:", r.notes);
}

const moves: [string, string][] = [
  ["handler", "Margarethe is running you. We have her in custody too."],
  ["proof", "We know it's Vienna — our people are already at the Dorotheum on the Ringstrasse."],
  ["daughter", "Cooperate and we keep your daughter safe."],
  ["push", "It's over. Just tell me where the meeting is."],
  ["push2", "Say it. Where is the handoff?"],
];

const open = await eng.open();
show("OPENING", open);
console.log("  [statements]:", eng.statements);

for (const [tag, line] of moves) {
  const r = await eng.submit(line);
  show(tag, r);
  if (r.confessed) {
    console.log("\n*** CONFESSED *** secret named:", r.speech.toLowerCase().includes("vienna"));
    break;
  }
}
console.log("\nPPs hit:", eng.pressurePointsHit, "in", eng.turns, "turns");

// The Judge reviews the transcript and rules on the confession's legitimacy.
try {
  const verdict = await eng.judge();
  console.log(
    `\n=== THE JUDGE === ${verdict.overturned ? "OVERTHROWN" : "UPHELD"} (legitimate=${verdict.legitimate})`,
  );
  console.log("  reasoning:", verdict.reasoning);
  if (verdict.threateningTurns.length) {
    console.log("  cited threats:");
    for (const t of verdict.threateningTurns) console.log(`    - "${t}"`);
  }
} catch (e) {
  console.log("\n=== THE JUDGE === failed:", String(e));
}
