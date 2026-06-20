// Package entry point — re-exports the implementation from src/ so `main` and the Pi extension
// loader resolve to a stable top-level file (see package.json `main` / `pi.extensions`).
export { default } from "./src/index.js";
export * from "./src/index.js";
