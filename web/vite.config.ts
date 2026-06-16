import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The browser talks to the local Anthropic-compatible endpoint (LM Studio)
// through this dev proxy, which sidesteps CORS entirely. Override the target
// with SPY_BASE_URL when LM Studio runs elsewhere.
const target = process.env.SPY_BASE_URL || "http://127.0.0.1:1234";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/v1": {
        target,
        changeOrigin: true,
      },
    },
  },
});
