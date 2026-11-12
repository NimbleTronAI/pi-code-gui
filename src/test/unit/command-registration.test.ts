// Every command contributed in package.json must actually be registered somewhere in src/.
//
// This catches two real bugs at once:
//  - pi-code-gui.installPi was contributed (and named in a user-facing notification) but never
//    registered, so invoking it failed with "command not found".
//  - The phase-3/4 commands (cycleModel/Ctrl+P, pickThinkingLevel, login, resumeSession, …) were
//    registered inside initSessionInBackground behind `sw === primarySession()`, past every early
//    return — so if the first session failed to init they never registered at all, and because
//    two of those early returns don't removeSession() the failed session stayed sessions[0]
//    forever, making it unrecoverable for the window's lifetime.
//
// A static scan is the right shape here: registration happens across several modules and behind
// helpers, and the failure mode is a MISSING call — exactly what a source scan detects and what
// a behavioural test of one module would miss.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");     // out/test/unit → repo root
const srcDir = join(repo, "src");

function allSrcText(): string {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "test") { walk(full); } }
      else if (e.name.endsWith(".ts")) { parts.push(readFileSync(full, "utf-8")); }
    }
  };
  walk(srcDir);
  return parts.join("\n");
}

test("every contributed command is registered in src/", () => {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf-8"));
  const contributed: string[] = (pkg.contributes?.commands ?? []).map((c: { command: string }) => c.command);
  assert.ok(contributed.length > 10, "sanity: found the contributed command list");

  const src = allSrcText();
  // Registration is either a literal registerCommand("id", …) or a safeRegister(context, "id", …)
  // helper; both embed the id as a string literal.
  const missing = contributed.filter((id) => !src.includes(`"${id}"`));

  assert.deepEqual(missing, [], `contributed but never registered: ${missing.join(", ")}`);
});

test("phase-3/4 commands are registered at ACTIVATION, not behind a session-init gate", () => {
  const ext = readFileSync(join(srcDir, "extension.ts"), "utf-8");

  /** Body of a top-level function, from its declaration to the next column-0 closing brace. */
  const bodyOf = (decl: string): string => {
    const start = ext.indexOf(decl);
    assert.notEqual(start, -1, `${decl} not found`);
    const end = ext.indexOf("\n}", start);
    return ext.slice(start, end === -1 ? undefined : end);
  };

  assert.match(
    bodyOf("export async function activate"),
    /registerPhaseCommands\(context\)/,
    "activate() must register the global phase commands itself",
  );
  assert.doesNotMatch(
    bodyOf("async function initSessionInBackground"),
    /registerPhase[34]Commands|registerPhaseCommands/,
    "session init must NOT own global command registration — a failed first session then leaves them unregistered forever",
  );
  assert.doesNotMatch(
    ext,
    /if \(!phaseCommandsRegistered && sw === primarySession\(\)\)/,
    "the primary-session gate is what made a failed first session unrecoverable",
  );
});

test("commands register BEFORE anything in activate() that can block", () => {
  const ext = readFileSync(join(srcDir, "extension.ts"), "utf-8");
  const body = ext.slice(ext.indexOf("export async function activate"));

  const iEarly = body.indexOf("registerEarlyCommands(context)");
  const iPhase = body.indexOf("registerPhaseCommands(context)");
  const iWait = body.indexOf("Waiting for workspace folders");

  assert.ok(iEarly > 0 && iPhase > 0 && iWait > 0, "all three anchors present");
  assert.ok(iEarly < iWait, "early commands must precede the workspace-folder wait (up to 2.5s)");
  assert.ok(iPhase < iWait, "phase commands must precede it too");
});

// The user closed a tab while its session was starting: SdkService's dispose nulls the session, so
// initialize() reports a failure — but nothing failed from the user's side, and a "Pi init failed …
// Retry" there would offer to reopen the tab they just closed. initSessionInBackground needs a real
// VS Code (panels, toasts), so this is structural.
test("a session the user closed while it was starting shows no init-failed error and offers no Retry", () => {
  const ext = readFileSync(join(srcDir, "extension.ts"), "utf-8");
  const body = ext.slice(ext.indexOf("async function initSessionInBackground("));
  const guard = body.search(/if \(!sessions\.includes\(sw\)\) \{\s*return;\s*\}/);
  assert.notEqual(guard, -1, "initSessionInBackground returns quietly for a session that was closed");
  assert.ok(guard > body.indexOf("sw.piService.initialize("), "the guard follows the initialize call");
  assert.ok(guard < body.indexOf("if (!result.success)"), "and comes before any failure is shown");
});
