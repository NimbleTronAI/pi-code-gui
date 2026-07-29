// Generate a SLIM model registry from @earendil-works/pi-ai (the same source the
// TypeScript runtime uses) and stamp the pi-ai version it came from. The extension
// bundles the output and uses it to override the Rust binary's stale built-in model
// list, so Rust gets the same fresh catalog as Pi — with no per-model config.
//
//   npm run gen:model-registry   ← run after a pi-ai bump (a manual pi-ai bump (there is no dependabot.yml)), then commit.
//
// a manual pi-ai bump (there is no dependabot.yml) tracks @earendil-works/pi-ai (a devDependency); check-model-registry
// fails the build when the stamped version drifts from the installed one, forcing
// a regen so prices/flags never go stale silently.
//
// Scope: only API-key providers (those with a real baseUrl). Special-auth cloud
// providers — Bedrock, Azure, Vertex, Copilot — carry an empty baseUrl and can't be
// expressed as a plain models.json entry, so they stay on the Rust binary's native
// handling and are intentionally skipped.
// pi-ai 0.81.0 removed the module-level getProviders()/getModels() this script was built on
// (0.82.1 fails at import: "does not provide an export named 'getModels'"). The built-in catalog
// moved behind ./providers/all, which exposes the same data through getBuiltinProviders() /
// getBuiltinModels(id) — the per-model field shape (baseUrl, api, reasoning, contextWindow,
// maxTokens, input, cost, thinkingLevelMap, compat) is unchanged, so only the enumeration moved.
import { getBuiltinProviders, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Read the version via fs (the package's exports map blocks `require(pkg/package.json)`).
const piAiVersion = JSON.parse(
  readFileSync(join(root, "node_modules", "@earendil-works", "pi-ai", "package.json"), "utf8"),
).version;

// Non-API-key providers stay on the Rust binary's native handling, identified by:
//   - a special api (AWS SigV4, Azure, GCP Vertex, ChatGPT/Codex OAuth backend),
//   - an OAuth provider (github-copilot), or
//   - an empty/templated baseUrl that needs account/region substitution
//     (azure → empty; vertex → {location}; cloudflare → {CLOUDFLARE_ACCOUNT_ID}).
const SPECIAL_APIS = new Set([
  "bedrock-converse-stream", "azure-openai-responses", "google-vertex", "openai-codex-responses",
]);
const SPECIAL_PROVIDERS = new Set(["github-copilot"]);

const providers = {};
const skipped = [];
let modelCount = 0;

for (const provId of getBuiltinProviders()) {
  const models = getBuiltinModels(provId) ?? [];
  if (!models.length) { continue; }
  const { baseUrl, api } = models[0];
  if (!baseUrl || baseUrl.includes("{") || SPECIAL_APIS.has(api) || SPECIAL_PROVIDERS.has(provId)) {
    skipped.push(provId); continue;
  }

  const entry = { baseUrl: models[0].baseUrl, api: models[0].api, models: [] };
  for (const m of models) {
    const slim = {
      id: m.id,
      name: m.name ?? m.id,
      reasoning: !!m.reasoning,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      input: Array.isArray(m.input) && m.input.length ? m.input : ["text"],
    };
    // Keep the per-model thinking metadata: thinkingLevelMap drives the extension's
    // dynamic level picker (which levels a model actually honors — e.g. DeepSeek
    // collapses minimal/low/medium) for BOTH backends, and is forwarded into rust-pi's
    // models.json so the Rust backend clamps identically. compat carries the wire
    // dialect (thinkingFormat, e.g. "deepseek") and forceAdaptiveThinking — the flag
    // that selects Anthropic's modern adaptive `effort` API over deprecated
    // budget_tokens. pi_agent_rust reads these under model.compat (gh #116/#117).
    if (m.thinkingLevelMap && typeof m.thinkingLevelMap === "object") {
      slim.thinkingLevelMap = m.thinkingLevelMap;
    }
    const compat = {};
    if (m.compat?.thinkingFormat) { compat.thinkingFormat = m.compat.thinkingFormat; }
    if (typeof m.compat?.forceAdaptiveThinking === "boolean") {
      compat.forceAdaptiveThinking = m.compat.forceAdaptiveThinking;
    }
    if (Object.keys(compat).length) { slim.compat = compat; }
    if (m.cost) {
      slim.cost = { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cacheRead, cacheWrite: m.cost.cacheWrite };
    }
    entry.models.push(slim);
    modelCount++;
  }
  providers[provId] = entry;
}

const out = { generatedFrom: "@earendil-works/pi-ai", piAiVersion, providers };
writeFileSync(join(root, "src", "model-registry.generated.json"), JSON.stringify(out) + "\n");
console.log(`model-registry.generated.json: ${Object.keys(providers).length} providers, ${modelCount} models (pi-ai ${piAiVersion}).`);
console.log(`Skipped special-auth providers: ${skipped.join(", ") || "(none)"}`);
