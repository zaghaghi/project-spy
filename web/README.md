# Project Spy — Web (React + TypeScript)

A browser version of the interrogation game. You question a captured spy and must
break their will until they confess a secret you already know. Same engine and
anti-cheat design as the Python CLI, ported to TypeScript.

## Run

LM Studio must be running on `http://127.0.0.1:1234` with a chat model loaded
(default `google/gemma-4-e2b`).

```bash
cd web
npm install
npm run dev      # http://localhost:5173
```

That's all — no backend. The Vite dev server **proxies** `/v1/*` to LM Studio
(see [vite.config.ts](vite.config.ts)), so the browser's requests are same-origin
and there's no CORS to configure. Point the proxy elsewhere with
`SPY_BASE_URL=http://host:port npm run dev`.

## Architecture

The same principle as the CLI: **the application is the referee, the model only
acts.** Because the player already knows the secret, nothing needs hiding from the
client, so the whole engine runs in the browser — no server required.

```
src/
  engine/
    types.ts      # shared types
    cases.ts      # the authoritative case ledgers (secret, facts, pressure points)
    llm.ts        # /v1/messages fetch client + defensive JSON extraction
    prompts.ts    # system prompt + per-turn injected state
    engine.ts     # GameEngine: scoring, validation, tiers, win check, trigger backstop
  useGame.ts      # React hook wrapping the engine
  components/     # StrainMeter, EvidencePanel, Transcript
  App.tsx         # setup screen, interrogation layout, debrief
```

The engine is a faithful port of `../spyengine`: identical scoring
(`vague_threat +5`, `specific_pressure -10`, `contradiction -20`,
`pressure_point -30`), contradiction validation against the statement log, the
code-side pressure-point **trigger backstop** for weak local models, secret-leak
redaction, and a guaranteed confession on break.

## UI notes

- **Strain meter** shows the spy's tier (composed → guarded → rattled → breaking →
  confessed), never the raw number — unless you tick *Referee scoring*.
- **Evidence Log** is the spy's own logged claims; **Pressure Points** reveal as
  you discover them.
- *Referee scoring* (a debug toggle) annotates each spy reply with the resolve
  delta, adjudicated move, and any pressure point / contradiction caught.

## Dev smoke test

`smoke.ts` drives the ported engine against the live endpoint from Node:

```bash
npx tsx smoke.ts
```
