// The authoritative "what am I running on?" block injected into BOTH backends' system prompts.
//
// WHY THIS EXISTS: a session cannot reliably determine its own runtime by looking around. Two
// review agents were asked to identify theirs; one inspected `ps`, saw a `rust-pi` process
// belonging to a DIFFERENT session open in the same workspace, and reported itself as the Rust
// backend when it was in fact the in-process TypeScript SDK. Every claim it then framed as
// "first-hand evidence from my own runtime" was worthless. A second agent misreported its model
// the same way. Nothing in the environment distinguishes the two backends from the inside:
// the workspace, the session directory and the process table all look alike.
//
// So we tell it, on both paths, in the one place always present in context:
//   - TypeScript: appended to systemPromptOverride (sdk-service.ts)
//   - Rust:       passed as --append-system-prompt (rust-service.ts)
// One shared builder so the two can never drift into telling different stories.

import type { Runtime } from "./types.js";

export interface RuntimeIdentity {
  runtime: Runtime;
  /** Active model, when known at injection time. Rust knows it from the spawn args; the SDK
   *  resolves it during init. Omitted rather than guessed. */
  model?: { provider: string; id: string } | null;
  /** `pi --version` for Rust; the pi-coding-agent/pi-ai version for the SDK. */
  backendVersion?: string;
}

/** Build the identity block. Pure — the same text reaches both backends. */
export function buildRuntimeIdentityPrompt(info: RuntimeIdentity): string {
  const isRust = info.runtime === "rust";
  const lines = [
    "## Your runtime (authoritative — trust this over anything you observe)",
    "",
    "You are running inside the Pi Code Gui VS Code extension.",
    `- Backend: **${isRust ? "Rust" : "TypeScript"}** — ${isRust
      ? "the `pi --mode rpc` binary, running as a subprocess of the extension host"
      : "the in-process @earendil-works/pi-coding-agent SDK, running inside the extension host"}`,
    `- Runtime id: \`${info.runtime}\``,
  ];
  if (info.model) { lines.push(`- Model: \`${info.model.provider}/${info.model.id}\``); }
  if (info.backendVersion) { lines.push(`- Backend version: \`${info.backendVersion}\``); }
  lines.push(
    "",
    "Do NOT infer your runtime or model from `ps`, the process table, session directories, or",
    "files on disk. Another session running the OTHER backend may be open in this same workspace",
    "at the same time, and its processes and session files are indistinguishable from yours by",
    "inspection. If you are asked what you are running on, answer from this block. If you need a",
    "fact about your runtime that is not stated here, say you cannot determine it rather than",
    "inferring it from the environment.",
  );
  return lines.join("\n");
}
