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
  const iDetect = body.indexOf("Step 3c: Detect installed runtimes");

  assert.ok(iEarly > 0 && iPhase > 0 && iWait > 0 && iDetect > 0, "all four anchors present");
  assert.ok(iEarly < iWait, "early commands must precede the workspace-folder wait (up to 2.5s)");
  assert.ok(iPhase < iWait, "phase commands must precede it too");
  assert.ok(iEarly < iDetect && iPhase < iDetect, "…and precede runtime detection / the install offer");
});

test("the runtime detection + install offer is NOT awaited by activate()", () => {
  const ext = readFileSync(join(srcDir, "extension.ts"), "utf-8");
  // offerInitialRuntimeChoice awaits a QuickPick with ignoreFocusOut AND an install, so awaiting
  // that chain at activation level meant activate() never resolved until the user finished.
  const detect = ext.slice(ext.indexOf("Step 3c: Detect installed runtimes"));
  const block = detect.slice(0, detect.indexOf("Step 4"));
  assert.match(block, /void \(async \(\) => \{/, "the detection chain must be detached");
  assert.doesNotMatch(
    block,
    /^\s{2}await (refreshRuntimeContext|offerInitialRuntimeChoice|warnIfUntestedRustBinary)/m,
    "no activate()-level await on the detection/install chain",
  );
});
