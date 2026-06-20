// Generate a SLIM model registry from @earendil-works/pi-ai (the same source the
// TypeScript runtime uses) and stamp the pi-ai version it came from. The extension
// bundles the output and uses it to override the Rust binary's stale built-in model
// list, so Rust gets the same fresh catalog as Pi — with no per-model config.
//
//   npm run gen:model-registry   ← run after a pi-ai bump (Dependabot), then commit.
//
// Dependabot tracks @earendil-works/pi-ai (a devDependency); check-model-registry
// fails the build when the stamped version drifts from the installed one, forcing
// a regen so prices/flags never go stale silently.
//
// Scope: only API-key providers (those with a real baseUrl). Special-auth cloud
// providers — Bedrock, Azure, Vertex, Copilot — carry an empty baseUrl and can't be
// expressed as a plain models.json entry, so they stay on the Rust binary's native
// handling and are intentionally skipped.
import { getProviders, getModels } from "@earendil-works/pi-ai";
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

for (const prov of getProviders()) {
  const provId = typeof prov === "string" ? prov : prov.id;
  const models = getModels(provId) ?? [];
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
