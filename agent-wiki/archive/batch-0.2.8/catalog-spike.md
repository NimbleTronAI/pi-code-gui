# Catalog spike: can a pi.dev runtime cache replace our build-time catalog?

Date 2026-10-17. Read-only. Sources: installed MIT Pi at
`/home/node/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent` (1.3.0, its nested pi-ai 1.3.0),
upstream `earendil-works/pi` via the GitHub API, live pi.dev probes (catalog only, no model-provider
traffic), rust-pi 0.8.0 black-box against a local mock server, and Rust issue/release prose. No Rust source was read.
Abbreviations: PCA = `pi-coding-agent/dist`, PIAI = `pi-coding-agent/node_modules/@earendil-works/pi-ai/dist`.

**Short answer.** Partly. For the TypeScript runtime: yes. Pi already gives us, in-process, a merged
bundled+pi.dev catalog (`ModelRuntime`), and we don't refresh it only because we never ask. For Rust-only
users: no, not safely. The overlay code is in pi-coding-agent, not pi-ai. The endpoint is internal and
picks its answer by Pi version, and the provider has never offered it to third parties. A bundled floor
has to stay. It just stops being the main source.

---

## 1. The pi.dev catalog fetch (PROVEN: source + live probes)

- **URL.** `https://pi.dev/api/models/providers/<providerId>?types=chat,image,classifier`, one request per
  provider (PCA/core/remote-catalog-provider.js:5,57-58). There is no whole-catalog call in the client.
  pi.dev does also serve `/api/models` (935 KB, probed) and `/api/models/providers` (42 provider ids, probed).
- **Request** (`:59-66`): `accept: application/json`, `User-Agent: pi/<VERSION> (...)`, optional `if-none-match`.
  Each attempt times out at 4 s, inside `fetchWithRetry`.
- **No auth.** Plain curl returns 200 (probed).
- **Conditional caching.** The ETag and Last-Modified are stored per provider. A 304 only moves `checkedAt` (`:98-107`).
  Probed: a second GET with the ETag gets `304`. The server sends `cache-control: public, max-age=60`.
  An unknown provider gets 404, which is stored as an empty overlay (`:109-118`).
- **Response shape.** With `?types=` the response is an **array of full pi-ai `Model` objects**. For
  `anthropic` it was field-for-field identical to `builtinProviders()…getAllModels()`: 17/17 models, no
  field or value differences, same keys (`id,name,api,provider,baseUrl,reasoning,input,cost,contextWindow,
  maxTokens,compat,thinkingLevelMap,promptCache,inputLimits,type`). **Without** `?types=` it is the legacy
  **object keyed by model id** (probed). `parseCatalog` accepts array, `{models}` or a keyed object (`:25-39`).
  The shape has already changed once.
- **The server picks the catalog by Pi version** (upstream `scripts/model-catalog-protocol.ts:97-125`):
  "clients that identify as Pi are redirected to the equivalent URL with an explicit `pi-version`.
  Requests without a Pi User-Agent receive the default catalog." Probed: UA `pi/1.3.0` gets a 307 to
  `&pi-version=1.3.0` with ETag ca78…, the same as no UA. UA `pi/0.84.4` gets a different catalog
  (ETag b67b…, 477 vs 482 OpenRouter models, a different `api` mix). Catalog revisions are keyed by
  `minimumPiVersion`, because `api`/`baseUrl` values only make sense to clients that can route them (#10847).
- **The overlay applies only when it is newer than the bundled data.** `isNewer(lastModified, getBuiltinModelDataGeneratedAt())`
  (`:50-55`). The overlay merges over bundled by `type\0id` (`:19-24`).
- **What triggers a refresh**
  - `ModelRuntime.create()` refreshes over the network only when `allowModelNetwork: true`, which
    **defaults to false** (PCA/core/model-runtime.d.ts:11-12, model-runtime.js:100-110).
  - The CLI in RPC mode runs a background `modelRuntime.refresh({signal})` after session creation
    (PCA/main.js:765-772). The interactive TUI does the same after init (modes/interactive/model-catalog-refresh.js).
  - **The 4 h TTL** (`REMOTE_CATALOG_REFRESH_INTERVAL_MS`, `:7,90-95`) skips the request when `checkedAt` is recent.
  - `pi update --models` uses `refresh({allowNetwork:true, force:true})` with a 15 s budget (PCA/package-manager-cli.js:535-555).
  - The SDK path `createAgentSession` → `agent-session-services.js:111` calls `refresh({allowNetwork:false})`,
    which restores the cache only and never touches the network.
  - **Only providers with a credential are fetched.** pi-ai `Models.refresh` returns early when
    `resolveRefreshCredential` yields nothing (PIAI/models.js:199-204,231-248).
- **PI_OFFLINE.** `modelNetworkEnabled = process.env.PI_OFFLINE === undefined`
  (PCA/core/model-runtime.js:97). That is the default `allowNetwork` for `refresh()` (`:600`). Any value,
  even `0` or empty, disables it. Upstream #8684 says this contradicts the documented `1/true/yes`, and it is unfixed.
  An explicit `allowNetwork:true` overrides it. That is what `update --models` does.
- **Public contract?** No. The docs only say Pi "can overlay newer catalog data from pi.dev" (docs/models.md:15).
  The endpoint, its shape and its version negotiation appear only in code and the shared protocol file.
  `https://pi.dev/api` answers `{"ok":false,"error":"API routes are reserved for future features."}` (probed).
  See §6.

## 2. In-process API (PROVEN)

- `ModelRuntime` is exported from pi-coding-agent's root (PCA/index.js:14, index.d.ts:15). These are the calls that matter:
  - `static create(opts?: CreateModelRuntimeOptions)`, with `allowModelNetwork?`, `modelRefreshTimeoutMs?`,
    `catalogBaseUrl?`, `refreshOnCreate?`, `modelsStorePath?` (d.ts:4-20)
  - `refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>`, taking `{allowNetwork?, force?, providers?, signal?}` (d.ts:109)
  - `getModels(providerId?)`, `getModel(provider,id)`, `getAllModels(providerId?)` (d.ts:70-74). These return the
    merged bundled + overlay + user models.json.
- **The extension already holds one.** src/sdk-service.ts:492 `this.modelRuntime = await SDK.ModelRuntime.create()`,
  with no options, so the network is off. Calling `await this.modelRuntime.refresh({signal})` with no
  `allowNetwork` does exactly what the CLI does in RPC mode: it obeys PI_OFFLINE, the 4 h TTL and ETags,
  and writes `~/.pi/agent/models-store.json`, which it shares with the CLI.
- **pi-ai alone cannot do this.** The only pi.dev reference in pi-ai is Radius (`providers/radius-config.js:1`).
  `withRemoteCatalog`, `FileModelsStore` and the merge all live in pi-coding-agent. pi-ai's
  `providers/all` gives only the bundled catalog (`getBuiltinModels`, `getBuiltinModelDataGeneratedAt`, …).

## 3. Why the cache on this machine is six weeks old (PROVEN cause; timestamps read only)

`~/.pi/agent/models-store.json` has only two providers. deepseek has checkedAt 2026-08-31, lastModified
2026-08-26, 3 models. anthropic has checkedAt 2026-08-26. The bundled data in 1.3.0 was generated
2026-10-15T19:00Z. The extension's `ModelRuntime.create()` runs with the network off, and
`createAgentSession` refreshes with `allowNetwork:false`. **The SDK path never refreshes over the
network. Only CLI/TUI startup and `pi update --models` do.** The cache is also useless at the moment:
its lastModified is older than the bundled data, so `isNewer` discards it. pi.dev today has
lastModified 2026-10-16 for anthropic, which is newer than the bundled data.

## 4. Rust cost (PROVEN black-box, without a real provider)

Setup: a scratch `PI_CODING_AGENT_DIR` holding a `models.json` that defines a custom `mockp/mock-1` with
rates `in 3 / out 15 / cacheRead 0.3 / cacheWrite 3.75` per Mtok, pointed at a local mock
OpenAI-compatible SSE server that reports 1,000,000 prompt and 1,000,000 completion tokens.
- `rust-pi -p --mode json …`: `message_end.message.usage.cost = {"input":3.0,"output":15.0,"cacheRead":0.0,"cacheWrite":0.0,"total":18.0}`
- `--mode rpc`, then `get_session_stats`: `"cost":18.0, "tokens":{"input":1000000,"output":1000000,…}`

So rust-pi 0.8.0 **prices each turn itself, using the rates in the models.json we write.** The comments
in src/usage-stats.ts:2,45 and src/model-catalog.ts `computeTokenCost` ("the Rust binary reports
cost:0") are **stale**. The owner's prose on Rust #221 says the same thing (issue thread, not source):
"nothing ever populated `usage.cost` … Fixed on `main` … The agent prices `usage` when a turn finalizes",
and for OpenRouter "the final usage chunk's billed `cost` lands in `usage.cost.total`". I have NOT
verified that OpenRouter detail; it would need a real OpenRouter call. Rust still needs *rates* from
somewhere: its own built-in catalog is old (`--list-models sonnet` in a clean dir shows no Sonnet 5).

## 5. Recommendation: what to keep, change and delete

Target design: **the runtime catalog comes from Pi's own `ModelRuntime` whenever TypeScript Pi is
installed. The bundled snapshot becomes a floor for Rust-only users and first runs.** We do not call
pi.dev ourselves.

| Piece | Verdict | Why / depends on |
|---|---|---|
| TS path: add `modelRuntime.refresh({signal})` (15 s, background, after session create) | ADD | The CLI does exactly this (main.js:765-772). It obeys PI_OFFLINE, the TTL and ETags, and fixes §3. Depends on undocumented-but-exported `refresh` semantics (stable since 0.80.8). |
| `findCatalogModelCost` / `reconcileThinkingCapability` on TS path | CHANGE | Look up `modelRuntime.getModel(p,id)` / `getAllModels()` first, which is the merged and fresh data. Use the snapshot only when that returns nothing. The SDK already prices with the live model object. |
| `findCatalogThinkingModel` / `activeCostRates` on Rust path | CHANGE | Same lookup order. If TS Pi is installed, use the ModelRuntime catalog, else the snapshot. |
| Rust cost: `computeTokenCost` + "binary reports 0" policy (usage-stats.ts) | CHANGE | Use the binary's `usage.cost` / `get_session_stats.cost` (§4). Keep our arithmetic only as a fallback. Recheck on each rust-pi pin. |
| `catalogRatesAreUnexpressible` (DeepSeek) | KEEP | This is a policy about billing, not about where the data comes from. Apply it on top of whatever cost the runtime reports. |
| `mergeModelsJson` inputs | CHANGE | Feed it `modelRuntime.getAllModels()` when TS Pi is present (the newest bundled catalog of the user's Pi plus the overlay, from pi.dev's version-matched answer). Otherwise feed it the snapshot. Keep the existing filters (`SPECIAL_APIS`, unsupported apis, `only`) unchanged. |
| `gen-model-registry.mjs` + `model-registry.generated.json` | KEEP (demoted) | This is the only source for Rust-only users, first runs with no TS Pi, offline use and PI_OFFLINE. It could later be slimmed to the fields we actually read. |
| `check-model-registry.mjs` consistency check | KEEP | It is deterministic and cheap, and it guards the floor. |
| `check-model-registry.mjs` currency check (STRICT mode) | KEEP code; urgency drops | Once the runtime catalog takes precedence, a stale floor only affects Rust-only and offline users. How release gating uses it is the founder's decision and is out of scope here. |
| release.yml / publish.yml gates | n/a | Excluded at the founder's request. |
| `@earendil-works/pi-ai` devDependency | KEEP | The generator needs it. |
| Dependabot ignore for pi-ai | KEEP | The reason (regenerate the floor and review prices by hand) still applies. |
| `FALLBACK_MODELS` | CHANGE | Build it from `modelRuntime.getModels()` when TS Pi is present, else the snapshot. |
| Fetch pi.dev directly from the extension | DO NOT (for now) | It is internal, depends on version negotiation, has already changed shape once, and nothing from the provider endorses it (§6). If Rust-only freshness ever matters, revisit after asking upstream. |

Scenarios:
- **Rust-only, no TS Pi.** They get the bundled snapshot, as today. The improvement is that rust-pi now prices turns itself from those rates.
- **First run offline.** `ModelRuntime` has the user's bundled pi-ai catalog, usually newer than our snapshot. Rust-only users get the snapshot. Nothing breaks.
- **PI_OFFLINE.** Our refresh inherits Pi's behaviour, so presence of the variable means no network. Never pass `allowNetwork:true`.
- **pi.dev changes shape.** That is Pi's problem, handled by Pi's parser, and it gets fixed by upgrading Pi.
  We read only `Model` objects from `ModelRuntime`. The worst case for us is a wrong overlay that Pi
  itself also serves to the CLI, as in #10992 and #9099.
- **Credential gap (INFERRED).** `ModelRuntime` overlays only providers credentialed in `~/.pi/agent`. A
  provider credentialed only in the Rust agent dir would get the TS bundled catalog without the overlay.
  That is still no worse than our snapshot.

Proven vs inferred: §1–§4 are proven by source, probes and mock runs. Two things in §5 are design
inference and have not been prototyped: that `getAllModels()` output can go straight into `mergeModelsJson`
(the shape match is proven for anthropic), and that the background refresh doesn't disturb a live session.

## 6. What the provider and users say

**Provider (Earendil maintainers).** CHANGELOG quotes are from the installed PCA/CHANGELOG.md.
- 0.80.8 (2026-07-16): "Added file-backed dynamic catalogs in `models-store.json`, per-provider pi.dev catalog overlays" and
  "throttle checks to once per four hours, send the versioned pi user agent, treat unimplemented routes as unavailable overlays."
- 0.82.1: "pi.dev catalogs revalidate with `If-None-Match` so unchanged providers answer with an empty `304`."
- 0.84.3: "Fixed hung pi.dev model catalog requests consuming the entire refresh deadline without retrying (#8198)."
- 0.99.0: "Added `types=chat,image,classifier` to pi.dev model catalog requests … entries of unknown model types are ignored."
- 1.3.0: "the model catalog pin is now refreshed from the newest published catalog when its model API groups differ" (#10985).
- Docs (models.md:15): "Pi starts with its bundled catalog and can overlay newer catalog data from pi.dev. Cached catalog data
  remains available offline; run `pi update --models` to force a refresh." env docs: `PI_OFFLINE` "Disable automatic network
  activity, including model catalog refreshes."
- Protocol file header (upstream `scripts/model-catalog-protocol.ts:1-13`): "Model catalog protocol shared by pi and pi.dev.
  … copied verbatim into two repositories … pi uses it to publish catalog revisions … pi.dev uses it to serve catalog requests."
  It describes a contract between Pi and pi.dev. No third party is mentioned.
- mitsuhiko (MEMBER) on PR #9763 (https://github.com/earendil-works/pi/pull/9763): "the catalog protocol now lives in
  `scripts/model-catalog-protocol.ts`, with an identical copy in pi.dev … The publisher and a coding-agent test run against the
  same selection logic pi.dev uses."
- christianklotz (COLLABORATOR) on PR #10847 (https://github.com/earendil-works/pi/pull/10847): "pi.dev selects catalogs by the
  User-Agent's Pi version"; old clients broke when "pi.dev served [new-api entries] to older clients".
- mitsuhiko on #8065 (https://github.com/earendil-works/pi/issues/8065): "There was a bug with 304 handling that should be
  resolved on the server now." On #8198 he added a client-side mitigation (4 s per attempt, 3 tries).
- davidbrai (MEMBER) on #10992 (https://github.com/earendil-works/pi/issues/10992), a remote catalog that broke kimi-coding:
  "this should be fixed now. run `pi update --models` if it's still giving errors." On #10658 (a Sonnet 5.5 cache-read
  price): "thanks, this is fixed". Price fixes reach users through pi.dev.
- badlogic (COLLABORATOR) on #8987 links users to `https://pi.dev/models?name=fable&provider=anthropic`, the human catalog page.
- **I found no statement endorsing, versioning or deprecating `/api/models*` for third parties.** I searched issues for
  catalog+public/stable/third-party, and searched Discussions (catalog, pi.dev, models-store): nothing relevant. pi.dev has no
  terms page (404), its `/api` root says routes are "reserved for future features", and robots.txt has only generic content-signal boilerplate.
  Verdict: **tolerated by being public and unauthenticated, but not endorsed. It is an internal protocol of Pi.**

**Users and integrators** (all statements below are users', not the provider's):
- markusylisiurunen (#8198): "The server implementation does not appear to be public, so it is difficult to investigate."
  bernardopg on the same issue: 4/9 requests hung, "rotates across provider endpoints."
- jamescrowley321 (#9099, open): pi.dev served a wrong OpenRouter `baseUrl`. "Any agent that resolves models through this
  registry POSTs to `https://openrouter.ai/api/chat/completions`." This is someone outside Pi consuming the registry directly, and it hurt them.
- trireg (#10992): the remote entry's `api`/`baseUrl` disagreed with the built-in transport, so every request was a 404, "once
  models-store.json contains a fresh kimi-coding entry." The overlay can break things, not only make them fresher.
- mxr576, chiptoe-svg, holny, gaoanze888 (#8684): `PI_OFFLINE` set to any value disables catalog discovery, which is
  undocumented. Several patches are offered; there is no maintainer reply or lgtm yet.
- rdbisme (#9479): on a first bootstrap Pi "only restores the cached model catalog and never fetches one." The issue was auto-closed.

**Rust side** (issue and release prose only):
- Owner on #221 (https://github.com/Dicklesworthstone/pi_agent_rust/issues/221): cost was never populated before; now
  "message_end.message.usage.cost and the session totals are now non-zero for any model the catalog has rates for." This matches §4.
- Owner on #117: the embedded models.dev catalog is authoritative for `reasoning`, and "the full `@earendil-works/pi-ai`
  generator/regeneration is deferred." rust-pi does not fetch pi.dev. Its freshness depends on the `models.json` we write.
- v0.5.0 notes: `providers.<id>.modelOverrides` in models.json can pin `cost` per model.

**Recommendation after this evidence:** unchanged, and firmer. Consume pi.dev only through Pi's `ModelRuntime`,
which the provider maintains, tests against the server protocol and version-negotiates. Do not fetch
`/api/models*` ourselves. The provider changes it per Pi version, has shipped broken entries to
direct consumers (#9099), and calls it a pi↔pi.dev protocol. If a Rust-only fresh feed is wanted, ask
upstream for a supported endpoint first.
