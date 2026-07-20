// Headless tests for the extracted login/logout flow (src/auth-flow.ts). vscode is behind
// the injected AuthUI, so the ORCHESTRATION is driven here with a scripted fake UI + a fake
// ModelRuntime — the ~180-line auth block was untested inside PiService.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLoginProviderItems, buildLogoutItems, makeAuthInteraction, runLogin, runLogout,
  type AuthUI, type AuthFlowDeps,
} from "../../auth-flow.js";

type Any = ReturnType<typeof JSON.parse>;

const PROVIDERS = [
  { id: "openai", name: "OpenAI", auth: { apiKey: true } },
  { id: "anthropic", name: "Anthropic", auth: { apiKey: true, oauth: true } },
  { id: "copilot", name: "GitHub Copilot", auth: { oauth: true } },
];

test("buildLoginProviderItems filters by auth type, annotates configured, sorts by name", () => {
  const oauth = buildLoginProviderItems(PROVIDERS, "oauth", (id) => id === "anthropic");
  assert.deepEqual(oauth.map((i) => i.id), ["anthropic", "copilot"]); // sorted, apiKey-only openai excluded
  assert.equal(oauth[0].description, "$(check) already configured"); // anthropic configured
  assert.equal(oauth[1].description, "");
  const key = buildLoginProviderItems(PROVIDERS, "api_key", () => false);
  assert.deepEqual(key.map((i) => i.id), ["anthropic", "openai"]); // copilot (oauth-only) excluded
});

test("buildLogoutItems maps provider name + credential kind, sorted", () => {
  const items = buildLogoutItems(
    [{ providerId: "openai", type: "api_key" }, { providerId: "anthropic", type: "oauth" }],
    (id) => (id === "openai" ? "OpenAI" : "Anthropic"),
  );
  assert.deepEqual(items, [
    { label: "Anthropic", id: "anthropic", description: "OAuth subscription" },
    { label: "OpenAI", id: "openai", description: "API key" },
  ]);
});

/** A UI that returns scripted quickPick/inputBox answers and records notifications. */
function fakeUI(script: { picks?: Any[]; inputs?: (string | undefined)[] } = {}): { ui: AuthUI; log: string[]; opened: string[] } {
  const picks = [...(script.picks ?? [])];
  const inputs = [...(script.inputs ?? [])];
  const log: string[] = [];
  const opened: string[] = [];
  const ui: AuthUI = {
    quickPick: async (items) => (picks.length ? picks.shift() : items[0]),
    inputBox: async () => (inputs.length ? inputs.shift() : "typed"),
    withProgress: async (_t, task) => { await task((m) => log.push(`progress:${m}`), new AbortController().signal); },
    openExternal: (u) => opened.push(u),
    info: (m) => log.push(`info:${m}`),
    error: (m) => log.push(`error:${m}`),
  };
  return { ui, log, opened };
}

function fakeRuntime(over: Partial<Record<string, Any>> = {}): Any {
  return {
    getProviders: () => PROVIDERS,
    hasConfiguredAuth: () => false,
    login: async () => {},
    refresh: async () => {},
    getAvailable: async () => [{ provider: "openai", id: "gpt-5" }],
    listCredentials: async () => [{ providerId: "openai", type: "api_key" }],
    getProvider: (id: string) => PROVIDERS.find((p) => p.id === id),
    logout: async () => {},
    ...over,
  };
}

function deps(rt: Any, ui: AuthUI, calls: string[] = []): AuthFlowDeps {
  return { modelRuntime: rt, getActiveModel: () => null, setModel: async (p, i) => { calls.push(`setModel:${p}/${i}`); }, ui };
}

test("runLogin: api-key happy path → login(provider,type,interaction) → refresh → auto-select model", async () => {
  const calls: string[] = [];
  const loginArgs: Any[] = [];
  const rt = fakeRuntime({ login: async (...a: Any[]) => { loginArgs.push(a); } });
  const { ui, log } = fakeUI({ picks: [{ authType: "api_key" }, { id: "openai", name: "OpenAI" }] });
  await runLogin(deps(rt, ui, calls));
  assert.equal(loginArgs[0][0], "openai");
  assert.equal(loginArgs[0][1], "api_key");
  assert.equal(typeof loginArgs[0][2].prompt, "function"); // the interaction adapter
  assert.deepEqual(calls, ["setModel:openai/gpt-5"]);       // completeLogin auto-selected
  assert.ok(log.some((l) => l.startsWith("info:Logged in to OpenAI")));
});

test("runLogin: cancel at the type picker → no login", async () => {
  const rt = fakeRuntime({ login: async () => { throw new Error("should not be called"); } });
  const { ui } = fakeUI({ picks: [undefined] });
  await runLogin(deps(rt, ui));
});

test("runLogin: no providers support the chosen type → info, no crash", async () => {
  const rt = fakeRuntime({ getProviders: () => [] });
  const { ui, log } = fakeUI({ picks: [{ authType: "oauth" }] });
  await runLogin(deps(rt, ui));
  assert.ok(log.some((l) => l.includes("No providers support subscription login")));
});

test("runLogout: pick a stored credential → logout(id) + refresh + confirmation", async () => {
  const logoutArgs: Any[] = [];
  const rt = fakeRuntime({ logout: async (id: string) => { logoutArgs.push(id); } });
  const { ui, log } = fakeUI({ picks: [{ id: "openai", label: "OpenAI", description: "API key" }] });
  await runLogout(deps(rt, ui));
  assert.deepEqual(logoutArgs, ["openai"]);
  assert.ok(log.some((l) => l.includes("Removed stored API key for OpenAI")));
});

test("runLogout: no stored credentials → info, no logout call", async () => {
  const rt = fakeRuntime({ listCredentials: async () => [], logout: async () => { throw new Error("nope"); } });
  const { ui, log } = fakeUI();
  await runLogout(deps(rt, ui));
  assert.ok(log.some((l) => l.includes("No stored credentials")));
});

test("makeAuthInteraction: auth_url notify opens the browser + reports; secret prompt uses a password box", async () => {
  const { ui, log, opened } = fakeUI({ inputs: ["sk-123"] });
  const it = makeAuthInteraction((m) => log.push(`progress:${m}`), new AbortController().signal, ui);
  it.notify({ type: "auth_url", url: "https://auth.example/x", instructions: "go" });
  assert.deepEqual(opened, ["https://auth.example/x"]);
  assert.ok(log.some((l) => l === "progress:go"));
  assert.equal(await it.prompt({ type: "secret", message: "key?" }), "sk-123");
});

test("makeAuthInteraction: a cancelled prompt (undefined input) throws 'Login cancelled'", async () => {
  const { ui } = fakeUI({ inputs: [undefined] });
  const it = makeAuthInteraction(() => {}, new AbortController().signal, ui);
  await assert.rejects(() => it.prompt({ type: "text", message: "x" }), /Login cancelled/);
});
