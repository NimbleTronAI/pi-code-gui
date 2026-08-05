// Pure, vscode-free runtime-selection decision. Extracted from runtime-detection.ts
// (which imports vscode) so the both/ts-only/rust-only/neither priority ordering
// can be unit-tested headlessly. The vscode config read stays in the caller.

import type { Runtime } from "./types.js";

/**
 * Resolve the runtime for a NEW session from what's installed plus the persisted
 * `defaultRuntime` setting:
 *  - both installed → the setting (`rust` only when it's exactly "rust", else `typescript`)
 *  - exactly one    → that one (never nag to install the other)
 *  - neither        → null (caller runs the install flow)
 */
export function pickDefaultRuntime(detected: { ts: boolean; rust: boolean }, setting: string): Runtime | null {
  if (detected.ts && detected.rust) { return setting === "rust" ? "rust" : "typescript"; }
  if (detected.ts) { return "typescript"; }
  if (detected.rust) { return "rust"; }
  return null;
}
