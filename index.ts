// Package entry point — re-exports the implementation from src/ so `main` and the Pi extension
// loader resolve to a stable top-level file (see package.json `main` / `pi.extensions`).
// Pi loads extensions through jiti, so the TypeScript source is consumed directly — no build step.
export { default } from "./src/index.ts";
export * from "./src/index.ts";
