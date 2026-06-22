import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.spec.ts"],
    // Each spec redirects PI_CODING_AGENT_DIR via process.env; the forks pool gives every
    // file its own process so that redirect can't leak between files.
    pool: "forks",
    // Real bash spawns and Orama persistence make a few specs slower than the 5s default.
    testTimeout: 30_000,
  },
});
