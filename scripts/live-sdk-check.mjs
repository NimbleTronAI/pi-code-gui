// Live check: run the REAL extension code against a REAL pi-coding-agent install, end to end.
//
//   pnpm run compile-tests     # builds out/pi-service.js, which this drives
//   node --import ./scripts/vscode-register.mjs scripts/live-sdk-check.mjs \
//       [--report live.md] [--json live.json] [--keep]
//
// Exit codes: 0 every check passed · 1 a check failed · 2 could not run (no SDK install, not built).
//
// WHY THIS EXISTS: src/pi-sdk-version.json's `testedAgainst` means "we ran the extension on this
// release", and until now that run was a scratch script rebuilt by hand for each release (1.5.2's
// lived in a session scratchpad). That made every Pi SDK bump a human chore, so the bump sat in
// an issue. Committing the run as a pass/fail check lets .github/workflows/upstream-currency.yml
// do it on a runner and open a PR that carries the result — see agent-wiki/operations/upstream-bump-prs.md.
//
// WHAT IT DRIVES: the real PiService → the real SdkService → the globally installed SDK (found the
// same way the extension finds it), with the production bridge tools, event translation, replay
// and active-tools restore. The vscode stub (scripts/vscode-stub.mjs) stands in for VS Code itself,
// so this proves the SDK seam, not the webview or VS Code's own APIs.
//
// MODEL: pi-ai's own FAUX provider, scripted below — no API key, no network, no cost, and the same
// answer every run. It is registered in the INSTALLED SDK's copy of pi-ai (the api-registry the
// SDK dispatches through) and declared to the SDK as an ordinary custom provider in models.json,
// so the SDK's agent loop, tool execution, compaction and persistence all run for real; only the
// HTTP call to a vendor is replaced. The script answers from the CONTEXT the SDK sends it, which is
// what makes the checks meaningful: the secret word comes back only if the read tool's real output
// reached the model, thinking streams only if the SDK passed the thinking level through, and the
// recall after reopen works only if the history (or the compaction summary) made it back into the
// context. What this does NOT cover is a vendor's wire format — that lives inside pi-ai, which
// tests it, and is not something the extension touches.
//
// Everything runs in a fresh temp dir: its own PI_CODING_AGENT_DIR, workspace and sessions dir, so
// it neither reads nor writes the user's ~/.pi.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as vscode from "vscode";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const REPORT = arg("--report");
const JSON_OUT = arg("--json");
const KEEP = process.argv.includes("--keep");
const PROMPT_TIMEOUT_MS = 60_000;
const SECRET = "PELICAN";
const MODEL = { provider: "faux", id: "faux-live", api: "faux-live-check" };

const results = [];
const log = (...a) => console.log(...a);
function check(step, ok, detail = "") {
  results.push({ step, ok: !!ok, detail: String(detail).slice(0, 300) });
  log(`${ok ? "PASS" : "FAIL"}  ${step}${detail ? `  — ${String(detail).slice(0, 300)}` : ""}`);
  return !!ok;
}

function finish(code, sdkVersion, note) {
  const passed = results.filter((r) => r.ok).length;
  const summary = { sdkVersion, model: `${MODEL.provider}/${MODEL.id} (scripted)`, ranAt: new Date().toISOString(), passed, failed: results.length - passed, ok: code === 0, note: note ?? null, results };
  if (JSON_OUT) { writeFileSync(JSON_OUT, JSON.stringify(summary, null, 2) + "\n"); }
  if (REPORT) {
    const L = [];
    L.push(`**Live check on pi-coding-agent ${sdkVersion ?? "(not found)"}: ${code === 0 ? "passed" : code === 2 ? "could not run" : "FAILED"}** (${passed}/${results.length} checks, ${summary.model})`);
    if (note) { L.push("", note); }
    if (results.length) {
      L.push("", "| check | result | detail |", "| --- | --- | --- |");
      for (const r of results) { L.push(`| ${r.step} | ${r.ok ? "pass" : "**FAIL**"} | ${r.detail.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`); }
    }
    writeFileSync(REPORT, L.join("\n") + "\n");
  }
  process.exit(code);
}

// ── preconditions ────────────────────────────────────────────────────
if (!existsSync(join(ROOT, "out", "pi-service.js"))) {
  console.error("out/pi-service.js is missing — run `pnpm run compile-tests` first.");
  finish(2, null, "out/pi-service.js was not built.");
}
const { PiService, resolvePiPackagePath } = await import(join(ROOT, "out", "pi-service.js"));

let sdkVersion = null, sdkDir = null;
try {
  sdkDir = resolvePiPackagePath();
  sdkVersion = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8")).version;
} catch (e) {
  finish(2, null, `No pi-coding-agent install found: ${e.message}`);
}
log(`pi-coding-agent ${sdkVersion}`);

/** The pi-ai the INSTALLED SDK resolves — nested under it, or hoisted next to it. A provider
 *  registered in any other copy (ours in node_modules, say) is invisible to the SDK. */
function sdkPiAiDir(from) {
  for (let d = from; ; d = dirname(d)) {
    const c = join(d, "node_modules", "@earendil-works", "pi-ai");
    if (existsSync(join(c, "package.json"))) { return c; }
    if (dirname(d) === d) { return null; }
  }
}
const piAiDir = sdkPiAiDir(sdkDir);
const compatEntry = piAiDir && JSON.parse(readFileSync(join(piAiDir, "package.json"), "utf8")).exports?.["./compat"]?.import;
if (!compatEntry) { finish(2, sdkVersion, `Could not find the SDK's pi-ai compat entry (looked from ${sdkDir}).`); }
const AI = await import(pathToFileURL(join(piAiDir, compatEntry)).href);
if (typeof AI.registerFauxProvider !== "function") {
  finish(2, sdkVersion, "The SDK's pi-ai has no registerFauxProvider, so the scripted model cannot be installed.");
}

// ── scratch environment ──────────────────────────────────────────────
const S = mkdtempSync(join(tmpdir(), "pi-live-"));
const AGENT = join(S, "agent"), WS = join(S, "ws"), SESS = join(S, "sessions");
for (const d of [AGENT, WS, SESS]) { mkdirSync(d, { recursive: true }); }
// keepRecentTokens 1: a two-turn session is otherwise "too small" to compact (Pi's guard, not a defect).
writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
writeFileSync(join(WS, "hello.txt"), `The secret word is ${SECRET}.\n`);
// The scripted model, declared the way a user declares any custom provider. `api` names the
// api-registry entry registerFauxProvider fills in below; the key is a placeholder the SDK needs
// to consider the provider configured, and nothing ever sends it anywhere.
writeFileSync(join(AGENT, "models.json"), JSON.stringify({
  providers: {
    [MODEL.provider]: {
      name: "Scripted (live check)", baseUrl: "http://faux.invalid", apiKey: "faux-live-check", api: MODEL.api,
      models: [{ id: MODEL.id, reasoning: true, input: ["text"], contextWindow: 128_000, maxTokens: 16_384,
                 cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    },
  },
}));
process.env.PI_CODING_AGENT_DIR = AGENT;

vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(WS), name: "ws", index: 0 }];
globalThis.__vscodeMock.config = {
  "pi-code-gui.defaultModelProvider": MODEL.provider,
  "pi-code-gui.defaultModelId": MODEL.id,
  "pi-code-gui.defaultThinkingLevel": "off",
  "pi-code-gui.sessionDir": SESS,
};

// ── the scripted model ───────────────────────────────────────────────
// One function answers every request, from the context it is handed. Each test prompt carries a
// cue; anything else (Pi's compaction request is the only other caller) gets a summary.
const textOf = (m) => typeof m.content === "string" ? m.content
  : (m.content ?? []).map((p) => p.text ?? p.thinking ?? "").join("");
const SECRET_RE = /secret word is ([A-Z]+)/;
const PROMPTS = {
  read: "Use the read tool to read hello.txt, then reply with only the secret word.",
  think: "A farmer has 17 sheep. All but 9 run away, then he buys twice as many as remain, then sells a third of his flock. How many sheep does he have? Reply with only the number.",
  bridge: "Call the vscode_get_workspace_folders tool, then the vscode_get_open_editors tool, then reply with only the workspace folder name.",
  recall: "What was the secret word from hello.txt earlier in this conversation? Do not use any tool. Reply with only the word, or UNKNOWN.",
};
const requests = [];
// The bridge-tool turn holds its first answer until the reload-mid-response check has run: a
// scripted model answers in milliseconds, so without this the turn could be over before the reload
// is attempted, and the check would be measuring a race instead of Pi's guard.
let releaseBridgeTurn;
const bridgeTurnGate = new Promise((r) => { releaseBridgeTurn = r; });
async function scriptedReply(context, options) {
  const msgs = context.messages;
  let u = msgs.length - 1;
  while (u >= 0 && msgs[u].role !== "user") { u--; }
  const ask = u >= 0 ? textOf(msgs[u]) : "";
  const since = msgs.slice(u + 1).filter((m) => m.role === "toolResult");
  const called = (name) => since.find((m) => m.toolName === name);
  requests.push({ ask: ask.slice(0, 40), reasoning: options?.reasoning ?? null, messages: msgs.length });
  const { fauxAssistantMessage: say, fauxText: text, fauxThinking: thinking, fauxToolCall: call } = AI;

  if (ask === PROMPTS.read) {
    const r = called("read");
    if (!r) { return say(call("read", { path: "hello.txt" }), { stopReason: "toolUse" }); }
    return say(textOf(r).match(SECRET_RE)?.[1] ?? "the read tool returned no secret");
  }
  if (ask === PROMPTS.think) {
    const blocks = [text("18")];
    if (options?.reasoning && options.reasoning !== "off") {
      blocks.unshift(thinking("9 remain. He buys 18 more, so 27. A third of 27 is 9, so 18 are left."));
    }
    return say(blocks);
  }
  if (ask === PROMPTS.bridge) {
    if (!called("vscode_get_workspace_folders")) { await bridgeTurnGate; return say(call("vscode_get_workspace_folders", {}), { stopReason: "toolUse" }); }
    if (!called("vscode_get_open_editors")) { return say(call("vscode_get_open_editors", {}), { stopReason: "toolUse" }); }
    return say("ws");
  }
  if (ask === PROMPTS.recall) {
    const earlier = msgs.slice(0, u).map(textOf).join("\n");
    return say(earlier.match(SECRET_RE)?.[1] ?? "UNKNOWN");
  }
  // Compaction: summarise from what the SDK handed over, so the summary carries the secret only if
  // the conversation really reached the summariser.
  const seen = msgs.map(textOf).join("\n").match(SECRET_RE)?.[1];
  return say(`## Goal\nExercise the session.\n\n## Progress\nRead hello.txt${seen ? `; the secret word is ${seen}` : ""}.`);
}
// The faux core takes a queue of steps; every step is the same function. Pi's session.reload()
// resets pi-ai's registry to the built-in providers (a user's custom providers come back because
// their extensions register again), so the check installs its test double again after a reload.
function installScriptedModel() {
  const faux = AI.registerFauxProvider({ api: MODEL.api, provider: MODEL.provider, models: [{ id: MODEL.id, reasoning: true }],
    tokensPerSecond: 2000, tokenSize: { min: 2, max: 5 } });
  faux.setResponses(Array.from({ length: 200 }, () => scriptedReply));
}
installScriptedModel();

// ── observation helpers ──────────────────────────────────────────────
/** Everything one PiService emits, plus the raw SDK events behind it. */
function observe(pi) {
  const o = { emitted: {}, raw: {}, unhandled: [], errors: [], tools: [], compaction: null, thinkingRaw: 0 };
  pi.onEvent((e) => {
    o.emitted[e.type] = (o.emitted[e.type] ?? 0) + 1;
    const c = e.data?.content;
    if (typeof c === "string" && c.startsWith("Unhandled agent event")) { o.unhandled.push(c); }
    if (e.type === "error" || e.data?.customType === "error") { o.errors.push(JSON.stringify(e.data).slice(0, 200)); }
  });
  o.subscribe = () => pi.session.subscribe((ev) => {
    o.raw[ev.type] = (o.raw[ev.type] ?? 0) + 1;
    if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "thinking_delta") { o.thinkingRaw++; }
    if (ev.type === "tool_execution_end") { o.tools.push({ name: ev.toolName, isError: !!ev.isError }); }
    if (ev.type === "compaction_end") { o.compaction = ev; }
  });
  return o;
}

const withTimeout = (p, what) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} did not finish within ${PROMPT_TIMEOUT_MS / 1000}s`)), PROMPT_TIMEOUT_MS)),
]);

function lastReply(pi) {
  const entries = pi.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const m = entries[i].message;
    if (entries[i].type === "message" && m?.role === "assistant") {
      return (m.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("").trim();
    }
  }
  return "";
}

async function prompt(pi, text, label) {
  try { await withTimeout(pi.sendPrompt(text), label); return lastReply(pi); }
  catch (e) { check(label, false, e.message); return null; }
}

const jsonl = (file) => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

// ── phase 1: fresh session ───────────────────────────────────────────
const pi1 = new PiService();
const o1 = observe(pi1);
const init1 = await pi1.initialize({ fresh: true });
const model1 = pi1._sdk?.getModel?.();
if (!check("init (fresh session)", init1.success, init1.success ? `model ${model1?.provider}/${model1?.id}` : init1.error)) {
  finish(1, sdkVersion);
}
o1.subscribe();
const bridge1 = pi1.getActiveToolNames().filter((n) => n.startsWith("vscode_"));
check("bridge tools registered", bridge1.length >= 16, `${bridge1.length} vscode_* tools active`);

let reply = await prompt(pi1, PROMPTS.read, "turn with a tool call");
if (reply !== null) {
  check("turn with a tool call", o1.tools.some((t) => t.name === "read" && !t.isError) && reply.toUpperCase().includes(SECRET),
    `tools ${JSON.stringify(o1.tools)}; reply ${JSON.stringify(reply.slice(0, 80))}`);
}

// Thinking: the scripted model thinks only when the SDK asks it to, so this proves the level set
// here reaches the provider AND that the SDK's thinking stream reaches the webview as
// thinking-delta events.
await pi1.setThinkingLevel("high");
{
  const rawBefore = o1.thinkingRaw, emittedBefore = o1.emitted["thinking-delta"] ?? 0;
  reply = await prompt(pi1, PROMPTS.think, "turn with thinking on");
  if (reply !== null) {
    const raw = o1.thinkingRaw - rawBefore, emitted = (o1.emitted["thinking-delta"] ?? 0) - emittedBefore;
    const asked = requests.at(-1)?.reasoning;
    check("turn with thinking on", raw > 0 && emitted >= raw && reply === "18",
      `level sent to the model: ${asked}; ${raw} SDK thinking deltas → ${emitted} thinking-delta events; reply ${JSON.stringify(reply.slice(0, 80))}`);
  }
}
await pi1.setThinkingLevel("off");

try {
  await withTimeout(pi1.compact(), "manual compaction");
  const c = o1.compaction;
  check("manual compaction", c && !c.aborted && !c.errorMessage && c.result?.summary,
    c ? `tokensBefore ${c.result?.tokensBefore}, summary ${c.result?.summary?.length ?? 0} chars${c.errorMessage ? `, error ${c.errorMessage}` : ""}` : "no compaction_end event");
} catch (e) { check("manual compaction", false, e.message); }

try {
  const out = await pi1.exportToHtml(join(S, "export.html"));
  check("HTML export", existsSync(out) && statSync(out).size > 0, `${existsSync(out) ? statSync(out).size : 0} bytes`);
} catch (e) { check("HTML export", false, e.message); }

const file = pi1.sessionManager.getSessionFile();
const kinds = {};
for (const l of jsonl(file)) { const k = l.type === "message" ? l.message?.role : l.type; kinds[k] = (kinds[k] ?? 0) + 1; }
check("session persisted", ["session", "user", "assistant", "toolResult", "compaction"].every((k) => kinds[k]), JSON.stringify(kinds));
check("phase 1: every SDK event handled", o1.unhandled.length === 0, o1.unhandled.join("; ") || `${Object.keys(o1.raw).length} event types seen`);
check("phase 1: no error surfaced", o1.errors.length === 0, o1.errors.join("; "));
pi1.dispose();

// ── phase 2: reopen, replay, bridge tools in the resumed session, reload guard ──
const pi2 = new PiService();
const o2 = observe(pi2);
const init2 = await pi2.initialize({ openPath: file });
if (!check("reopen (openPath)", init2.success && pi2.sessionManager.getSessionFile() === file, init2.error ?? "same file")) {
  finish(1, sdkVersion);
}
check("replay", ["chat-message", "tool-start", "compaction-summary-message"].every((t) => o2.emitted[t]),
  JSON.stringify(Object.fromEntries(["chat-message", "assistant-start", "tool-start", "compaction-summary-message"].map((t) => [t, o2.emitted[t] ?? 0]))));
o2.subscribe();

const pending = withTimeout(pi2.sendPrompt(PROMPTS.bridge), "bridge-tool turn");
for (let waited = 0; !pi2.session.isStreaming && waited < 15_000; waited += 20) { await new Promise((r) => setTimeout(r, 20)); }
// SdkService maps this exact wording to "busy-response" (see reloadContext); if Pi rewords it, the
// extension's "wait, then reload" message silently becomes a raw error. So check the wording itself.
try {
  await pi2.session.reload();
  check("Pi refuses a reload mid-response", false, `reload resolved (isStreaming=${pi2.session.isStreaming})`);
} catch (e) {
  check("Pi refuses a reload mid-response", /^Wait for the current response/.test(e.message), JSON.stringify(e.message));
}
releaseBridgeTurn();
try {
  await pending;
  const names = o2.tools.filter((t) => t.name.startsWith("vscode_"));
  check("bridge tools in the resumed session",
    ["vscode_get_workspace_folders", "vscode_get_open_editors"].every((n) => names.some((t) => t.name === n && !t.isError)),
    `${JSON.stringify(names)}; reply ${JSON.stringify(lastReply(pi2).slice(0, 80))}`);
} catch (e) { check("bridge tools in the resumed session", false, e.message); }
try { const r = await pi2.reloadContext(); check("reload when idle", r === "reloaded", r); }
catch (e) { check("reload when idle", false, e.message); }
installScriptedModel();
check("phase 2: every SDK event handled", o2.unhandled.length === 0, o2.unhandled.join("; ") || `${Object.keys(o2.raw).length} event types seen`);
check("phase 2: no error surfaced", o2.errors.length === 0, o2.errors.join("; "));

// ── phase 3: a /tools-narrowed set survives reopen, and so does the history ──
pi2.setActiveTools(["read", "vscode_get_workspace_folders"]);
pi2.dispose();
const pi3 = new PiService();
const o3 = observe(pi3);
const init3 = await pi3.initialize({ openPath: file });
if (check("reopen after narrowing tools", init3.success, init3.error ?? "")) {
  o3.subscribe();
  const active = pi3.getActiveToolNames().slice().sort().join(",");
  check("narrowed tool set restored", active === "read,vscode_get_workspace_folders", active);
  const ctx = pi3.sessionManager.buildSessionContext().messages.length;
  check("history kept after a tools change", ctx > 0, `${ctx} context messages`);
  // The scripted model answers only from the context it is sent, so this passes only if the
  // reopened session handed the model its history (here, the compaction summary).
  reply = await prompt(pi3, PROMPTS.recall, "history reaches the model after reopen");
  if (reply !== null) { check("history reaches the model after reopen", reply === SECRET, JSON.stringify(reply.slice(0, 80))); }
  check("phase 3: every SDK event handled", o3.unhandled.length === 0, o3.unhandled.join("; "));
  check("phase 3: no error surfaced", o3.errors.length === 0, o3.errors.join("; "));
  pi3.dispose();
}

if (KEEP) { log(`scratch kept at ${S}`); } else { rmSync(S, { recursive: true, force: true }); }
finish(results.every((r) => r.ok) ? 0 : 1, sdkVersion);
