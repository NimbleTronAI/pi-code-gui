// Pi Code Gui 0.2.0–0.2.3 (and the 0.2.8 pre-releases) wrote model entries into the user's own
// ~/.pi/agent/models.json, each stamped `"_managedBy": "pi-code-gui@<version>"`. Pi itself
// reads that file too, so the entries outlive the feature that wrote them. These tests pin the
// cleanup that removes them on every activation: only what we wrote goes, everything of the user's
// stays value-for-value and key-for-key, and a file we cannot rewrite safely is never written.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  cleanupManagedModels, cleanupManagedModelsAtStartup, managedModelsFile, type CleanupResult,
} from "../../managed-models-cleanup.js";

const here = dirname(fileURLToPath(import.meta.url)); // out/test/unit
const repo = join(here, "..", "..", "..");

function tmpFile(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "managed-cleanup-"));
  const file = join(dir, "models.json");
  if (contents !== undefined) { writeFileSync(file, contents); }
  return file;
}
const read = (file: string): any => JSON.parse(readFileSync(file, "utf-8"));
/** Set the file's mtime into the past, so "not even touched" is observable. */
function age(file: string): number {
  const old = new Date(Date.now() - 60_000);
  utimesSync(file, old, old);
  return old.getTime();
}
const pretty = (doc: unknown): string => JSON.stringify(doc, null, 2) + "\n";

/** An entry exactly as 0.2.3 wrote it into models[] (connection unstamped on the provider). */
const ours = (id: string, ver = "0.2.3"): any => ({
  id, name: `Name ${id}`, contextWindow: 128000, maxTokens: 8192, input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }, reasoning: true,
  compat: { thinkingLevelMap: { high: "high" }, thinkingFormat: "openai" }, _managedBy: `pi-code-gui@${ver}`,
});
/** An override exactly as 0.2.8-pre wrote it into modelOverrides. */
const ourOverride = (): any => ({ name: "x", contextWindow: 1, reasoning: false, _managedBy: "pi-code-gui@0.2.8" });
const mine = (id: string): any => ({ id, name: `Mine ${id}`, contextWindow: 2, input: ["text"], reasoning: false });

// ── what is removed ───────────────────────────────────────────────────

test("marked models[] entries and modelOverrides values are removed; unmarked siblings keep their values, keys and order", () => {
  const userProvider = { apiKey: "MY_KEY", baseUrl: "https://my-proxy.example/v1", api: "openai-completions",
    models: [mine("a"), ours("gone"), mine("b")], modelOverrides: { z: { name: "my z" }, gone: ourOverride(), y: { contextWindow: 5 } } };
  const file = tmpFile(pretty({ $schema: "x", providers: { custom: userProvider, other: { baseUrl: "https://o.example" } } }));
  const r = cleanupManagedModels(file);
  assert.equal(r.outcome, "removed");
  const doc = read(file);
  assert.deepEqual(Object.keys(doc), ["$schema", "providers"]);
  assert.deepEqual(Object.keys(doc.providers), ["custom", "other"], "provider order kept");
  assert.deepEqual(Object.keys(doc.providers.custom), ["apiKey", "baseUrl", "api", "models", "modelOverrides"], "key order kept");
  assert.deepEqual(doc.providers.custom.models, [mine("a"), mine("b")]);
  assert.deepEqual(Object.keys(doc.providers.custom.modelOverrides), ["z", "y"]);
  assert.deepEqual(doc.providers.custom.modelOverrides, { z: { name: "my z" }, y: { contextWindow: 5 } });
  assert.deepEqual(doc.providers.other, { baseUrl: "https://o.example" });
  assert.deepEqual((r as any).removed.sort(), ["custom/gone (models)", "custom/gone (modelOverrides)"].sort());
});

test("a models array, modelOverrides object or provider our removal empties is removed; one you left empty stays", () => {
  const file = tmpFile(pretty({ providers: {
    zai: { headers: { a: "1" }, models: [ours("gone")], modelOverrides: { gone: ourOverride() } },
    deepseek: { headers: { a: "1" }, models: [], modelOverrides: {} },
    onlyOurs: { modelOverrides: { gone: ourOverride() } },
    yoursEmpty: {},
  } }));
  cleanupManagedModels(file);
  const doc = read(file);
  assert.deepEqual(doc.providers.zai, { headers: { a: "1" } }, "ours emptied them: removed");
  assert.deepEqual(doc.providers.deepseek, { headers: { a: "1" }, models: [], modelOverrides: {} }, "yours stay");
  assert.equal(doc.providers.onlyOurs, undefined, "a provider our removal emptied is removed");
  assert.deepEqual(doc.providers.yoursEmpty, {}, "a provider you left empty is yours");
});

test("a file holding only ours keeps `providers` (Pi requires it): {\"providers\":{}} + newline", () => {
  const file = tmpFile(pretty({ providers: { deepseek: { baseUrl: "https://api.deepseek.com", api: "openai-completions", models: [ours("deepseek-chat")] } } }));
  assert.equal(cleanupManagedModels(file).outcome, "removed");
  assert.equal(readFileSync(file, "utf-8"), '{\n  "providers": {}\n}\n');
});

test("0.2.3's connection: an object of only our models[] entries loses a pair we shipped; another pair, or a model of yours, keeps it", () => {
  const file = tmpFile(pretty({ providers: {
    deepseek: { baseUrl: "https://api.deepseek.com", api: "openai-completions", models: [ours("deepseek-chat"), ours("deepseek-reasoner")] },
    zai: { baseUrl: "https://my-zai-proxy.example/v4", api: "openai-completions", models: [ours("z-own")] },
    groq: { baseUrl: "https://api.groq.com/openai/v1", api: "openai-completions", models: [ours("g"), mine("my-g")] },
    // 0.2.3 filled baseUrl/api into an object of yours that had only an apiKey.
    xai: { apiKey: "XAI", baseUrl: "https://api.x.ai/v1", api: "openai-responses", models: [ours("grok")] },
  } }));
  cleanupManagedModels(file);
  const doc = read(file);
  assert.equal(doc.providers.deepseek, undefined, "shipped pair and our models gone, and the emptied object with them");
  assert.deepEqual(doc.providers.zai, { baseUrl: "https://my-zai-proxy.example/v4", api: "openai-completions" }, "a pair we never shipped is yours");
  assert.deepEqual(doc.providers.groq, { baseUrl: "https://api.groq.com/openai/v1", api: "openai-completions", models: [mine("my-g")] });
  assert.deepEqual(doc.providers.xai, { apiKey: "XAI" });
});

test("0.2.8-pre provider-level stamp is removed", () => {
  const file = tmpFile(pretty({ providers: {
    "kimi-coding": { baseUrl: "https://api.kimi.com/coding/v1", api: "openai-completions", _managedBy: "pi-code-gui@0.2.8", models: [ours("k2", "0.2.8")] },
    mine: { headers: { a: "1" }, _managedBy: "pi-code-gui@0.2.8" },
  } }));
  cleanupManagedModels(file);
  const doc = read(file);
  assert.equal(doc.providers["kimi-coding"], undefined);
  assert.deepEqual(doc.providers.mine, { headers: { a: "1" } });
});

// ── what is never touched ─────────────────────────────────────────────

test("a foreign _managedBy (or a non-string one) is untouched and the file is not written", () => {
  const text = pretty({ providers: { p: {
    models: [{ ...mine("a"), _managedBy: "someone-else@1.0" }, { ...mine("b"), _managedBy: "pi-code-gui" }, { ...mine("c"), _managedBy: 7 }],
    modelOverrides: { x: { name: "x", _managedBy: "my-tool@pi-code-gui@" } },
  } } });
  const file = tmpFile(text);
  const past = age(file);
  // The text mentions pi-code-gui@ (in the foreign stamp), so this goes past the fast path.
  const r = cleanupManagedModels(file);
  assert.equal(r.outcome, "unchanged");
  assert.equal(readFileSync(file, "utf-8"), text);
  assert.equal(statSync(file).mtimeMs, past, "not even touched");
});

test("adopt-if-edited: a stamped entry you added a key to is yours, kept whole with its stamp; alone it causes no write", () => {
  const edited = [
    { ...ours("h"), headers: { "X-Mine": "1" } },
    { ...ours("t"), cost: { ...ours("t").cost, tiers: [] } },
    { ...ours("c"), compat: { thinkingFormat: "deepseek", supportsDeveloperRole: false } },
  ];
  const text = pretty({ providers: { custom: { baseUrl: "https://my.example", api: "openai-completions", models: edited, modelOverrides: { o: { ...ourOverride(), headers: {} } } } } });
  const file = tmpFile(text);
  const past = age(file);
  const r = cleanupManagedModels(file);
  assert.equal(r.outcome, "unchanged");
  assert.equal((r as any).why, "kept-only");
  assert.deepEqual((r as any).kept.sort(), ["custom/c (models)", "custom/h (models)", "custom/o (modelOverrides)", "custom/t (models)"]);
  assert.equal(readFileSync(file, "utf-8"), text);
  assert.equal(statSync(file).mtimeMs, past);
});

test("adopt-if-edited beside a plain entry on a shipped pair: only the plain one goes; the pair and the edited entry stay byte-equal", () => {
  const editedEntry = { ...ours("edited"), headers: { "X-Mine": "1" } };
  const file = tmpFile(pretty({ providers: { deepseek: { api: "openai-completions", baseUrl: "https://api.deepseek.com", models: [editedEntry, ours("plain")] } } }));
  cleanupManagedModels(file);
  assert.deepEqual(read(file).providers.deepseek, { api: "openai-completions", baseUrl: "https://api.deepseek.com", models: [editedEntry] });
});

test("no-op: nothing of ours, an already-clean file, or a second run leaves bytes and mtime unchanged", () => {
  const plain = '{"providers":{"x":{"baseUrl":"https://x.example"}}}';
  const f1 = tmpFile(plain);
  const p1 = age(f1);
  assert.deepEqual(cleanupManagedModels(f1), { outcome: "unchanged", why: "nothing-ours" });
  assert.equal(readFileSync(f1, "utf-8"), plain);
  assert.equal(statSync(f1).mtimeMs, p1);

  const f2 = tmpFile(pretty({ providers: { deepseek: { headers: { a: "1" }, models: [ours("x")] } } }));
  assert.equal(cleanupManagedModels(f2).outcome, "removed");
  const first = readFileSync(f2, "utf-8");
  const p2 = age(f2);
  assert.equal(cleanupManagedModels(f2).outcome, "unchanged", "idempotent");
  assert.equal(readFileSync(f2, "utf-8"), first);
  assert.equal(statSync(f2).mtimeMs, p2, "not even touched");
});

test("a commented models.json with nothing of ours is a silent no-op (Pi accepts comments; nothing to say)", () => {
  const text = '{ // mine\n "providers": {}, }';
  const file = tmpFile(text);
  const past = age(file);
  assert.deepEqual(cleanupManagedModels(file), { outcome: "unchanged", why: "nothing-ours" });
  assert.equal(readFileSync(file, "utf-8"), text);
  assert.equal(statSync(file).mtimeMs, past);
});

test("each file we cannot rewrite safely (comment, trailing comma, BOM, syntax, non-object shapes) is never written: bytes and mtime unchanged, the why and the fix in the message", () => {
  const S = '"_managedBy": "pi-code-gui@0.2.3"';
  const e = `{ "id": "m", ${S} }`;
  const cases: Array<[string, string, string]> = [
    ["comment", `{ // mine\n "providers": { "p": { "models": [${e}] } } }`, "parse"],
    ["trailing comma", `{ "providers": { "p": { "models": [${e},] } } }`, "parse"],
    ["syntax", `{ "providers": { "p": { "models": [${e}`, "parse"],
    ["BOM", `﻿{ "providers": { "p": { "models": [${e}] } } }`, "bom"],
    ["top level array", `[${e}]`, "shape"],
    ["top level string", JSON.stringify(S), "shape"],
    ["providers array", `{ "providers": [${e}] }`, "shape"],
    ["provider null", `{ "providers": { "p": null, "q": { "models": [${e}] } } }`, "shape"],
    ["provider string", `{ "providers": { "p": "x", "q": { "models": [${e}] } } }`, "shape"],
    ["models object", `{ "providers": { "p": { "models": { "m": ${e} } } } }`, "shape"],
    ["models entry not an object", `{ "providers": { "p": { "models": [1, ${e}] } } }`, "shape"],
    ["modelOverrides array", `{ "providers": { "p": { "modelOverrides": [${e}] } } }`, "shape"],
    ["override value not an object", `{ "providers": { "p": { "modelOverrides": { "a": true, "m": ${e} } } } }`, "shape"],
  ];
  for (const [name, text, reason] of cases) {
    const file = tmpFile(text);
    const past = age(file);
    const r = cleanupManagedModels(file) as any;
    assert.equal(r.outcome, "unsafe", name);
    assert.equal(r.reason, reason, name);
    assert.equal(readFileSync(file, "utf-8"), text, `${name}: bytes unchanged`);
    assert.equal(statSync(file).mtimeMs, past, `${name}: mtime unchanged`);
    assert.ok(r.message.includes(file), `${name}: names the file`);
    assert.match(r.message, /has not been changed/, `${name}: says nothing was written`);
    assert.match(r.message, reason === "shape" ? /isn't shaped like a models file/ : /plain JSON/, `${name}: the fix`);
    assert.equal(readdirSync(dirname(file)).length, 1, `${name}: no temp file left behind`);
  }
});

test("a read error other than ENOENT, a read-only file and a read-only folder: never written, and the message says why", () => {
  const dir = mkdtempSync(join(tmpdir(), "managed-eisdir-"));
  const asDir = join(dir, "models.json");
  mkdirSync(asDir);
  const r = cleanupManagedModels(asDir) as any;
  assert.equal(r.outcome, "unsafe");
  assert.equal(r.reason, "read");
  assert.match(r.message, /could not be read \(EISDIR\), so Pi Code Gui could not check it for the model entries earlier versions may have added/);
  assert.ok(statSync(asDir).isDirectory());

  const text = pretty({ providers: { p: { models: [ours("m")] } } });
  const ro = tmpFile(text);
  chmodSync(ro, 0o444);
  const past = age(ro);
  const rr = cleanupManagedModels(ro) as any;
  assert.equal(rr.outcome, "unsafe");
  assert.equal(rr.reason, "readonly");
  assert.match(rr.message, /is read-only/);
  assert.equal(readFileSync(ro, "utf-8"), text);
  assert.equal(statSync(ro).mtimeMs, past);
  assert.equal(statSync(ro).mode & 0o777, 0o444, "mode unchanged");
});

test("a read-only folder (a symlink's target folder included): never written, and the message names that folder", { skip: process.getuid?.() === 0 ? "root can write a 0555 folder" : false }, () => {
  const text = pretty({ providers: { p: { models: [ours("m")] } } });
  const roDir = tmpFile(text);
  chmodSync(dirname(roDir), 0o555);
  const linkDir = mkdtempSync(join(tmpdir(), "managed-rolink-"));
  const link = join(linkDir, "models.json");
  symlinkSync(roDir, link);
  try {
    for (const f of [roDir, link]) {
      const rd = cleanupManagedModels(f) as any;
      assert.equal(rd.outcome, "unsafe");
      assert.equal(rd.reason, "readonly");
      assert.ok(rd.message.includes(`folder \`${dirname(roDir)}\` is read-only`), rd.message);
      assert.equal(readFileSync(roDir, "utf-8"), text);
    }
    assert.ok(lstatSync(link).isSymbolicLink());
  } finally { chmodSync(dirname(roDir), 0o755); }
});

test("a missing file is a no-op and is not created; a dangling symlink is left a link", () => {
  const file = tmpFile();
  assert.deepEqual(cleanupManagedModels(file), { outcome: "unchanged", why: "absent" });
  assert.equal(existsSync(file), false);
  const linkDir = mkdtempSync(join(tmpdir(), "managed-dangling-"));
  const link = join(linkDir, "models.json");
  symlinkSync(join(linkDir, "dotfiles", "models.json"), link);
  assert.deepEqual(cleanupManagedModels(link), { outcome: "unchanged", why: "absent" });
  assert.ok(lstatSync(link).isSymbolicLink());
});

// ── how it is written ─────────────────────────────────────────────────

test("written as 0.2.x wrote it (2-space, trailing newline): a file 0.2.x last wrote changes only by the removed lines", () => {
  const before = { providers: { mine: { baseUrl: "https://mine.example", api: "openai-completions", models: [mine("a")] },
    deepseek: { baseUrl: "https://api.deepseek.com", api: "openai-completions", models: [ours("deepseek-chat")] } } };
  const file = tmpFile(pretty(before));
  cleanupManagedModels(file);
  const { deepseek, ...rest } = before.providers;
  void deepseek;
  assert.equal(readFileSync(file, "utf-8"), pretty({ providers: rest }));
});

test("a symlinked models.json is written through to its target, which keeps its mode; no temp file is left behind", () => {
  const real = tmpFile(pretty({ providers: { p: { headers: { a: "1" }, models: [ours("m")] } } }));
  chmodSync(real, 0o600);
  const linkDir = mkdtempSync(join(tmpdir(), "managed-link-"));
  const link = join(linkDir, "models.json");
  symlinkSync(real, link);
  assert.equal(cleanupManagedModels(link).outcome, "removed");
  assert.ok(lstatSync(link).isSymbolicLink(), "the link is still a link");
  assert.deepEqual(read(real), { providers: { p: { headers: { a: "1" } } } });
  assert.equal(statSync(real).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dirname(real)), ["models.json"]);
  assert.deepEqual(readdirSync(linkDir), ["models.json"]);
});

test("a file changed between read and rename is cleaned again from your bytes, never overwritten; one that keeps changing is left alone", () => {
  const file = tmpFile(pretty({ providers: { p: { models: [ours("m")] } } }));
  let saves = 0;
  const r = cleanupManagedModels(file, { beforeRename: () => {
    if (saves++ === 0) { writeFileSync(file, pretty({ providers: { p: { models: [ours("m")] }, mine: { baseUrl: "https://mine.example" } } })); }
  } });
  assert.equal(r.outcome, "removed");
  assert.deepEqual(read(file), { providers: { mine: { baseUrl: "https://mine.example" } } }, "your save survived, ours still went");
  const busy = tmpFile(pretty({ providers: { p: { models: [ours("m")] } } }));
  let n = 0;
  const save = (k: number): string => pretty({ n: k, providers: { p: { models: [ours("m")] } } });
  const r2 = cleanupManagedModels(busy, { beforeRename: () => { writeFileSync(busy, save(++n)); } });
  assert.equal(r2.outcome, "raced");
  assert.equal(readFileSync(busy, "utf-8"), save(2), "your last save stands");
  assert.deepEqual(readdirSync(dirname(busy)), ["models.json"], "no temp file left behind");
});

test("a write that fails leaves the original untouched and reports it (fail closed)", () => {
  const text = pretty({ providers: { p: { models: [ours("m")] } } });
  const file = tmpFile(text);
  const r = cleanupManagedModels(file, { beforeRename: () => { throw new Error("disk full"); } }) as CleanupResult & { message?: string };
  assert.equal(r.outcome, "failed");
  assert.match(r.message ?? "", /disk full/);
  assert.equal(readFileSync(file, "utf-8"), text);
  assert.deepEqual(readdirSync(dirname(file)), ["models.json"], "temp removed");
});

test("a file that is not valid UTF-8, or holds a value JSON cannot write back unchanged, is never written", () => {
  const stamped = JSON.stringify(ours("m"));
  const bad = Buffer.concat([Buffer.from(`{ "providers": { "p": { "headers": { "X": "caf`), Buffer.from([0xe9]), Buffer.from(`" }, "models": [${stamped}] } } }`)]);
  const f1 = tmpFile();
  writeFileSync(f1, bad);
  const p1 = age(f1);
  const r1 = cleanupManagedModels(f1) as any;
  assert.equal(r1.outcome, "unsafe");
  assert.equal(r1.reason, "encoding");
  assert.match(r1.message, /isn't valid UTF-8/);
  assert.ok(readFileSync(f1).equals(bad), "bytes unchanged");
  assert.equal(statSync(f1).mtimeMs, p1);

  const huge = `{ "providers": { "p": { "models": [{ "id": "mine", "contextWindow": 1e400 }, ${stamped}] } } }`;
  const f2 = tmpFile(huge);
  const p2 = age(f2);
  const r2 = cleanupManagedModels(f2) as any;
  assert.equal(r2.outcome, "unsafe");
  assert.equal(r2.reason, "value");
  assert.match(r2.message, /cannot be written back unchanged/);
  assert.equal(readFileSync(f2, "utf-8"), huge);
  assert.equal(statSync(f2).mtimeMs, p2);
});

test("the temp file is never one an attacker planted: a symlink at the old predictable temp name is not followed", () => {
  const file = tmpFile(pretty({ providers: { p: { headers: { a: "1" }, models: [ours("m")] } } }));
  const victim = join(mkdtempSync(join(tmpdir(), "managed-victim-")), "victim.txt");
  writeFileSync(victim, "untouched");
  symlinkSync(victim, join(dirname(file), `.models.json.pi-code-gui-${process.pid}.tmp`));
  assert.equal(cleanupManagedModels(file).outcome, "removed");
  assert.equal(readFileSync(victim, "utf-8"), "untouched");
  assert.ok(!lstatSync(file).isSymbolicLink(), "models.json is a regular file");
  assert.deepEqual(read(file), { providers: { p: { headers: { a: "1" } } } });
});

// ── where the file is ─────────────────────────────────────────────────

test("managedModelsFile resolves models.json as Pi's getAgentDir does", () => {
  const home = "/home/someone";
  assert.equal(managedModelsFile({}, home), join(home, ".pi", "agent", "models.json"));
  assert.equal(managedModelsFile({ PI_CODING_AGENT_DIR: "" }, home), join(home, ".pi", "agent", "models.json"), "empty is unset");
  assert.equal(managedModelsFile({ PI_CODING_AGENT_DIR: "/opt/pi" }, home), join("/opt/pi", "models.json"));
  assert.equal(managedModelsFile({ PI_CODING_AGENT_DIR: "~" }, home), join(home, "models.json"));
  assert.equal(managedModelsFile({ PI_CODING_AGENT_DIR: "~/pi-home" }, home), join(home, "pi-home", "models.json"));
  assert.equal(managedModelsFile({ PI_CODING_AGENT_DIR: pathToFileURL("/opt/pi url").href }, home), join("/opt/pi url", "models.json"));
  assert.equal(managedModelsFile({}), join(homedir(), ".pi", "agent", "models.json"), "home defaults to the OS home");
});

test("at startup: Pi's file and the default home 0.2.x wrote to are both cleaned, each logged; one warning per unsafe file", () => {
  const home = mkdtempSync(join(tmpdir(), "managed-home-"));
  const defaultFile = join(home, ".pi", "agent", "models.json");
  mkdirSync(dirname(defaultFile), { recursive: true });
  writeFileSync(defaultFile, pretty({ providers: { p: { models: [ours("m")] } } }));
  const envDir = mkdtempSync(join(tmpdir(), "managed-env-"));
  writeFileSync(join(envDir, "models.json"), `{ // mine\n "providers": { "p": { "models": [{ "id": "m", "_managedBy": "pi-code-gui@0.2.3" }] } } }`);
  const logs: Record<"info" | "warn" | "debug", string[]> = { info: [], warn: [], debug: [] };
  const log = { info: (m: string) => logs.info.push(m), warn: (m: string) => logs.warn.push(m), debug: (m: string) => logs.debug.push(m) };
  cleanupManagedModelsAtStartup(log, { PI_CODING_AGENT_DIR: envDir }, home);
  assert.deepEqual(read(defaultFile), { providers: {} }, "the default home is cleaned");
  assert.equal(logs.info.length, 1);
  assert.ok(logs.info[0].includes(defaultFile) && logs.info[0].includes("p/m (models)"), logs.info[0]);
  assert.equal(logs.warn.length, 1, "one warning for the unparseable file");
  assert.ok(logs.warn[0].includes(join(envDir, "models.json")));

  // Unset env: Pi's file IS the default — cleaned once, not twice; a clean file is debug-only.
  const logs2: string[] = [];
  cleanupManagedModelsAtStartup({ info: (m) => logs2.push(`info ${m}`), warn: (m) => logs2.push(`warn ${m}`), debug: (m) => logs2.push(`debug ${m}`) }, {}, home);
  assert.equal(logs2.length, 1);
  assert.match(logs2[0], /^debug /);
});

test("at startup it never throws, even when the logger does", () => {
  const home = mkdtempSync(join(tmpdir(), "managed-throw-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "models.json"), pretty({ providers: { p: { models: [ours("m")] } } }));
  const boom = (): void => { throw new Error("logger gone"); };
  assert.doesNotThrow(() => cleanupManagedModelsAtStartup({ info: boom, warn: boom, debug: boom }, {}, home));
});

// ── wiring and contracts ──────────────────────────────────────────────

test("activate() runs the cleanup on every activation, before its first await, with no flag", () => {
  const ext = readFileSync(join(here, "..", "..", "extension.js"), "utf-8");
  const body = ext.slice(ext.indexOf("async function activate(")).replace(/^\s*\/\/.*$/gm, ""); // comments are not code
  const at = body.indexOf("cleanupManagedModelsAtStartup(");
  assert.notEqual(at, -1, "activate() calls cleanupManagedModelsAtStartup");
  assert.ok(at < body.indexOf("await "), "before the first await, so a failed await cannot skip it");
  const src = readFileSync(join(repo, "src", "extension.ts"), "utf-8");
  const line = src.split("\n").find((l) => l.includes("cleanupManagedModelsAtStartup(")) ?? "";
  assert.match(line, /setImmediate\(/, "fire-and-forget");
  assert.doesNotMatch(src.slice(src.indexOf("export async function activate("), src.indexOf("cleanupManagedModelsAtStartup(")).split("\n").slice(-3).join("\n"), /\bif\s*\(/, "not behind a flag");
});

test("C4: the cleanup module stands alone — no vscode import", () => {
  const text = readFileSync(join(repo, "src", "managed-models-cleanup.ts"), "utf-8");
  assert.doesNotMatch(text, /from\s+["']vscode["']/);
});
