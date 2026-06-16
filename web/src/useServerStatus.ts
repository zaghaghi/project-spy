import { useEffect, useState } from "react";
import { fetchStatus, type ServerStatus } from "./engine/llm";

// Polls the inference sidecar until the model is ready. Keeps polling through
// "unreachable" (server still booting) and "error" so a restart recovers on its
// own; stops once ready.
export function useServerStatus(pollMs = 1000): ServerStatus | null {
  const [status, setStatus] = useState<ServerStatus | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const s = await fetchStatus();
      if (!alive) return;
      setStatus(s);
      if (!s || s.phase !== "ready") timer = setTimeout(tick, pollMs);
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [pollMs]);

  return status;
}
