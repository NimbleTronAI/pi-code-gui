// SdkService — owns the in-process TypeScript SDK runtime (@earendil-works/
// pi-coding-agent), mirroring how RustService owns the out-of-process Rust one.
//
// Extracted from PiService (the audits' top structural finding: the Rust path was
// cleanly extracted, the TS path never was). SdkService owns the SDK *plumbing* —
// module resolution/loading, pi-ai version adaptation, auth/registry/settings,
// model selection, ResourceLoader, tools, SessionManager, and createAgentSession
// (the old init Steps 1–9). PiService remains the runtime-agnostic orchestrator:
// it applies the returned shared state and wires the session to the UI (event
// subscription, extension binding, history replay — the old Steps 10–12), and all
// per-method runtime branching still lives there, reaching the SDK objects through
// thin getters over this service.
// This module is vscode-free (like RustService): every environment dependency —
// config reads, workspace cwd, dynamic module import, filesystem, the outdated-SDK
// UI nudge — is injected through `SdkDeps`, so the whole resolve→load→session init
// sequence is driven headlessly in unit tests (see sdk-service.test.ts). The real
// vscode-backed deps are built by PiService.makeSdkDeps().
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as fs from "node:fs";
import { piDebug, piWarn } from "./logger.js";
import { piAiVersionNotice } from "./version-compare.js";
import { buildRuntimeIdentityPrompt } from "./runtime-identity.js";
import type { PlanMode, ApprovalMode } from "./types.js";
import bundledRegistry from "./model-registry.generated.json";
import { clampThinkingLevel, reconcileThinkingCapability, findCatalogModelCost, type ThinkingModel } from "./model-catalog.js";
import { humanizeProviderError } from "./extension-errors.js";
import type { PiServiceEvent } from "./types.js";
import { backendCapabilityDefaults, type BackendCapabilities, type BackendUsage, type PiBackend } from "./pi-backend.js";

/** The bundled pi-ai catalog providers map shape (a subset of
 *  model-registry.generated.json) — reasoning + thinkingLevelMap + cost per model. */
export type CatalogProviders = Record<string, { models: Array<ThinkingModel & { id: string; cost?: { input: number; output: number; cacheRead: number; cacheWrite: number } }> }>;

/** The pi-ai SDK version this extension targets (the 0.80 model-API redesign:
 *  createModels()/providers-all). Below this we still run via a legacy fallback,
 *  but warn the user once per host to update. */
const SUPPORTED_PI_AI_VERSION = "0.80.0";

/** The pi-ai version this build of the extension is actually current with — taken from the
 *  bundled catalog, which is generated from it. Self-maintaining: every `pnpm run
 *  gen:model-registry` moves this target, so shipping a fresher catalog automatically starts
 *  nudging users whose SDK predates it. That matters because the catalog is what the extension
 *  hands the backends: models, thinking tiers and PRICING it carries can outrun an older SDK. */
const TARGET_PI_AI_VERSION = (bundledRegistry as { piAiVersion?: string }).piAiVersion ?? SUPPORTED_PI_AI_VERSION;
let _piAiVersionWarned = false;

/** The specifier to hand `import()` for a path on disk.
 *
 *  Node's ESM loader parses its argument as a URL, so a Windows absolute path is read as a
 *  protocol: `C:\\Users\\...\\dist\\index.js` fails with "Only URLs with a scheme in: file,
 *  data, node, and electron are supported ... Received protocol 'c:'". Every SDK module this
 *  extension loads is addressed by an absolute path built with path.join, so on Windows the
 *  TypeScript runtime could not start at all (gh #71).
 *
 *  pathToFileURL is the standard-library answer and handles drive letters, UNC paths and
 *  percent-encoding correctly — none of which a string concat of "file://" gets right. Applied
 *  on every platform, not just win32: on POSIX it is a faithful no-op in effect (an absolute
 *  path becomes file:///... which the loader resolves identically), and a platform-conditional
 *  would leave the POSIX path untested by the same code the Windows path uses. Relative and
 *  bare specifiers (package names) are passed through untouched — they are not filesystem
 *  paths and must keep resolving through Node's normal algorithm. */
export function importSpecifierFor(modulePath: string): string {
  return path.isAbsolute(modulePath) ? pathToFileURL(modulePath).href : modulePath;
}

/**
 * Dynamic import with retry — handles the race where npm is still populating
 * node_modules when the extension host first activates. Exported: PiService's
 * static helpers (checkInstall/listSessions) reuse the same loader.
 */
export async function importWithRetry(
  modulePath: string,
  maxAttempts: number,
  delayMs: number,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const target = importSpecifierFor(modulePath);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await import(target);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (attempt === maxAttempts) { throw e; }
      piWarn(`importWithRetry: attempt ${attempt}/${maxAttempts} failed for ${target}: ${e.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// ── Types for the dynamically loaded SDK ──────────────────

/* eslint-disable @typescript-eslint/no-explicit-any -- dynamically imported SDK; types unavailable at compile time */
export interface PiSdk {
  createAgentSession: Function;
  SessionManager: any;
  SettingsManager: any;
  // ModelRuntime (pi-coding-agent >= 0.80.8) is the unified async auth+model facade
  // that replaced the removed AuthStorage + ModelRegistry.create(auth) pair.
  ModelRuntime: any;
  createCodingTools: Function;
  createReadOnlyTools: Function;
  DefaultResourceLoader: any;
  defineTool: Function;
  getAgentDir: Function;
  createSyntheticSourceInfo: Function;
}

export interface PiAi {
  getModel: Function;
  getProviders: Function;
  complete: Function;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── System prompt / context files / prompt templates ──────
// TS-SDK-only resources (they reference the vscode_* bridge tools, which exist
// only on this runtime), assembled into the SDK's DefaultResourceLoader.

/** Build the VS Code-aware system prompt */
function buildSystemPrompt(identity?: { provider: string; id: string } | null): string {
  // The identity block goes FIRST: it is the one fact a session cannot work out for itself,
  // and the one a reviewer is most likely to get wrong (see runtime-identity.ts).
  return `${buildRuntimeIdentityPrompt({ runtime: "typescript", model: identity })}

You are a coding assistant running inside VS Code through the Pi Code Gui extension.
You have access to VS Code editor state through bridge tools (prefixed with vscode_)
when they are enabled.

Key information about your environment:
- You are embedded in VS Code as an extension with a webview chat UI.
- When bridge tools are active, you can inspect editor state, diagnostics, symbols,
  hover info, definitions, references, and apply edits through VS Code.
- For reading files, use the read tool (supports offset/limit for large files).
- For editing files, use the edit or write tool.

When the user asks you to fix something:
1. Check diagnostics first if the diagnostics bridge tool is available.
2. Look at the relevant code.
3. Make edits.

Be concise and helpful. Prefer editing existing files over creating new ones.`;
}

/** Build virtual context files (project guidelines for VS Code context) */
function buildContextFiles(cwd: string): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];

  // Check if project has a package.json to infer project type
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pkgJson: any = null;
  try {
    const pkgPath = path.join(cwd, "package.json");
    if (fs.existsSync(pkgPath)) {
      pkgJson = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    }
  } catch (e: unknown) { piWarn(`Non-critical failure: ${e instanceof Error ? e.message : String(e)}`); }

  // Check for common config files
  const hasTypeScript = fs.existsSync(path.join(cwd, "tsconfig.json"));
  const hasVite = fs.existsSync(path.join(cwd, "vite.config.ts")) || fs.existsSync(path.join(cwd, "vite.config.js"));
  const hasNextJS = pkgJson?.dependencies?.next || pkgJson?.devDependencies?.next;
  const hasReact = pkgJson?.dependencies?.react || pkgJson?.devDependencies?.react;
  const hasNodeBackend = pkgJson?.dependencies?.express || pkgJson?.dependencies?.fastify || pkgJson?.dependencies?.hono;

  files.push({
    path: "/virtual/vscode-guidelines.md",
    content: `# VS Code Extension Guidelines

## Running in Pi Code Gui
- You are an AI coding assistant inside VS Code.
- The user interacts with you through a chat webview.
- You have access to VS Code editor state through bridge tools when they are enabled.
- Bridge tools (prefixed vscode_) let you inspect open editors, diagnostics, symbols, and more.

## Interaction Tips
- Before making changes, check for diagnostics if the diagnostics tool is available.
- If the user mentions a file, verify it exists and check its content.
- When editing, use the edit or write tool.`,
  });

  if (hasTypeScript) {
    files.push({
      path: "/virtual/project-stack-typescript.md",
      content: `# Project Stack

This project uses TypeScript. Follow these conventions:
- Use strict typing, avoid 'any'.
- Import using ES module syntax.
- Use const over let where possible.
- Prefer async/await over raw promises.`,
    });
  }

  if (hasReact || hasNextJS || hasVite) {
    files.push({
      path: "/virtual/project-stack-frontend.md",
      content: `# Frontend Project Guidelines

This is a ${hasNextJS ? "Next.js" : hasVite ? "Vite-based" : "React"} project.
- Use functional components with hooks.
- Keep components focused and single-responsibility.
- Use proper TypeScript types for props.`,
    });
  }

  if (hasNodeBackend) {
    files.push({
      path: "/virtual/project-stack-backend.md",
      content: `# Backend Project Guidelines

This is a Node.js backend project.
- Handle errors gracefully with proper status codes.
- Validate inputs.
- Use async/await for async operations.`,
    });
  }

  return files;
}

/** Build custom slash commands */
function buildPromptTemplates(
  createSyntheticSourceInfo: Function,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Array<{ name: string; description: string; filePath: string; sourceInfo: any; content: string }> {
  const syn = (p: string): unknown => createSyntheticSourceInfo(p, { source: "vscode-gui" });

  return [
    {
      name: "fix-diagnostics",
      description: "Fix all diagnostics in open file",
      filePath: "/virtual/prompts/fix-diagnostics.md",
      sourceInfo: syn("/virtual/prompts/fix-diagnostics.md"),
      content: `# Fix Diagnostics

Check the currently open file for diagnostics using vscode_get_diagnostics.
For each diagnostic, analyze the root cause and apply a fix.
Explain what you're fixing and why.`,
    },
    {
      name: "explain-code",
      description: "Explain the code at current cursor position",
      filePath: "/virtual/prompts/explain-code.md",
      sourceInfo: syn("/virtual/prompts/explain-code.md"),
      content: `# Explain Code

Use vscode_get_editor_state to find what file and selection the user has open.
Read the relevant code section and explain what it does, its purpose, and how it works.
If the selection is empty, explain the function/module at the cursor position (use vscode_get_hover for additional context).`,
    },
    {
      name: "refactor",
      description: "Refactor the selected code",
      filePath: "/virtual/prompts/refactor.md",
      sourceInfo: syn("/virtual/prompts/refactor.md"),
      content: `# Refactor

Get the current selection with vscode_get_selection.
Analyze the code and suggest/apply refactoring improvements:
- Extract repeated logic into functions
- Simplify complex expressions
- Improve variable naming
- Add missing type annotations
- Reduce nesting

Apply your changes using edit tools.`,
    },
  ];
}

// ── SdkService ────────────────────────────────────────────

/** What SdkService needs from its owner: the event sink (for the message-renderer
 *  hook that must be live DURING createAgentSession) and the SDK package resolver
 *  (stays in PiService — its statics use it too, and passing it avoids a cycle). */
export interface SdkHost {
  emit(event: PiServiceEvent): void;
  resolvePiRoot(): string;
}

/** The pi-code-gui settings SdkService reads at init (snapshot, not cached). */
export interface SdkConfig {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  defaultModelProvider?: string;
  defaultModelId?: string;
  defaultThinkingLevel: string;
  contextBudget: number;
  sessionDir?: string;
}

/** Environment dependencies SdkService needs, injected so its init/handshake is
 *  headlessly testable (mirrors RustDeps). The real vscode-backed impl lives in
 *  PiService.makeSdkDeps(); tests supply stubs. */
export interface SdkDeps {
  workspaceCwd(): string;
  config(): SdkConfig;
  /** Dynamic module import with retry. Test seam: stubs return fake SDK/AI objects. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  importModule(absPath: string): Promise<any>;
  fileExists(p: string): boolean;
  readFileUtf8(p: string): Promise<string>;
  /** Surface the "installed pi-ai is older than supported" nudge (UI; no-op in tests). */
  /** `belowFloor` distinguishes "we fall back to a legacy code path" (a real compatibility
   *  problem) from "a newer tested version exists" (a nudge). */
  notifyOutdatedPiAi(installed: string, supported: string, belowFloor: boolean): void;
  /** Build the vscode_* bridge tools (keeps the vscode-coupled bridge-tools module
   *  out of this file, so SdkService stays headlessly importable). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildBridgeTools(defineTool: Function, typebox: any): any[];
  /** The bundled pi-ai catalog providers (authoritative capability/cost source).
   *  Injected rather than imported so this module needs no JSON import (headless). */
  catalogProviders(): CatalogProviders | undefined;
  /** Ask the user whether a pi extension may run a custom message renderer (arbitrary JS) in
   *  the webview. Remembered per custom type; see the TRUST BOUNDARY note at the call site. */
  confirmRendererConsent(customType: string): Promise<boolean>;
}

/** The shared state PiService applies after a successful SDK init. */
export interface SdkInitOutcome {
  success: boolean;
  error?: string;
  errorKind?: string;
  warning?: string;
  /** Final active model identity (after default/resume/reconcile overrides). */
  model?: { id?: string; name?: string; provider?: string };
  /** Models for /model cycling (registry-available, or built-in fallbacks). */
  cycleModels?: Array<{ provider: string; id: string }>;
  /** The clamped thinking level the session was created with. */
  thinkingLevel?: string;
  /** True when an existing session file was opened/continued (drives the
   *  active-tools restore in PiService). */
  isResuming?: boolean;
}

export class SdkService implements PiBackend {
/* eslint-disable @typescript-eslint/no-explicit-any -- dynamically imported SDK objects */
  public piRoot: string | null = null;
  public SDK: PiSdk | null = null;
  public AI: PiAi | null = null;
  /** Unified auth+model facade (pi-coding-agent >= 0.80.8), replacing the removed
   *  authStorage + modelRegistry. Async: created via `await ModelRuntime.create()`. */
  public modelRuntime: any = null;
  /** The active model identity — OWNED here (set at init + on setModel), read by
   *  PiService via the PiBackend getModel() seam. */
  private _model: { id?: string; name?: string; provider?: string; api?: string; reasoning?: boolean } | null = null;
  /** The active thinking level — OWNED here (set at init + on setThinkingLevel), read by
   *  PiService via getThinkingLevel(). */
  private _thinkingLevel = "off";
  public settingsManager: any = null;
  public sessionManager: any = null;
  public resourceLoader: any = null;
  public session: any = null;
/* eslint-enable @typescript-eslint/no-explicit-any */

  constructor(private readonly host: SdkHost, private readonly deps: SdkDeps) {}

  /** What the in-process TypeScript runtime can do — the full feature surface (bridge
   *  tools, interactive cards, /tools, fork, reload, export, rename). PiService reads
   *  these instead of hard-coding `_backendKind === "typescript"` gates. The SDK handles
   *  thinking per-provider in-process, so the level is always "live"; and PiService
   *  intercepts builtin slash commands before session.prompt (as the CLI does). */
  // ── Session modes: the SDK has neither plan mode nor an approval posture. Inert rather
  //    than absent, so PiService can call the seam without narrowing to a concrete class;
  //    capabilities.sessionModes is what gates the UI.
  get planMode(): PlanMode { return "off"; }
  get approvalMode(): ApprovalMode { return "always-ask"; }
  get currentSessionPath(): string | null { return null; }
  async setPlanMode(_on: boolean): Promise<PlanMode> { return "off"; }
  async setSessionName(name: string): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sess = (this as any).sessionManager ?? (this as any).session;
    if (typeof sess?.setSessionName !== "function") { return false; }
    sess.setSessionName(name);
    return true;
  }
  async approvePlan(): Promise<string | null> { return null; }
  async rejectPlan(): Promise<boolean> { return false; }

  get capabilities(): BackendCapabilities {
    // All flags are the runtime default for TypeScript (everything on; thinking always live in
    // process). Single source of truth — see backendCapabilityDefaults.
    return backendCapabilityDefaults("typescript");
  }

  /** Resolve, load, and wire the TypeScript SDK up to a live agent session
   *  (the former PiService init Steps 1–9). Never throws; failures come back as
   *  `{success:false, error}` exactly as before the extraction. */
  async initialize(opts: { fresh: boolean; openPath: string | null }): Promise<SdkInitOutcome> {
    const { fresh, openPath } = opts;

    // ── Step 1: Resolve SDK ────────────────────────────
    try {
      this.piRoot = this.host.resolvePiRoot();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return { success: false, error: `SDK not found: ${e.message ?? e}` };
    }

    // ── Step 2: Load SDK modules ───────────────────────
    try {
      this.SDK = (await this.deps.importModule(path.join(this.piRoot, "dist/index.js"))) as PiSdk;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return { success: false, error: `Failed to load pi-coding-agent: ${e.message ?? e}` };
    }

    try {
      this.AI = (await this.deps.importModule(path.join(this.piRoot, "node_modules/@earendil-works/pi-ai/dist/index.js"))) as PiAi;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      const msg = e.message ?? String(e);
      // Detect common missing-dependency patterns caused by broken npm global
      // installs and give a specific fix instruction.
      const openaiMatch = msg.match(/openai\/index\.js/);
      const anthroMatch = msg.match(/@anthropic-ai\/sdk/);
      if (openaiMatch || anthroMatch) {
        return {
          success: false,
          error:
            `Missing dependency (${openaiMatch ? "openai" : "@anthropic-ai/sdk"}). ` +
            `This is usually caused by a broken npm global install. ` +
            `Fix: npm uninstall -g @earendil-works/pi-coding-agent && npm install -g @earendil-works/pi-coding-agent`,
        };
      }
      return { success: false, error: `Failed to load pi-ai: ${msg}` };
    }

    // pi-ai 0.80 redesigned the model API: the static catalog reads (getModel /
    // getModels) and `complete` were removed from the root entrypoint — new code
    // uses createModels()/builtin factories (see pi-ai README "Migrating from the
    // Old Global API"). We load whichever pi-coding-agent is installed globally,
    // so on a 0.80+ SDK every AI.getModel(...) threw "is not a function". When the
    // root entrypoint lacks getModel, adapt AI to the durable providers/all
    // entrypoint (getBuiltinModel + a builtinModels() instance) — NOT the
    // deprecated /compat surface, which upstream will delete. Purely additive: on
    // 0.79.x getModel/complete are already present and this branch is skipped.
    await this.warnIfPiAiOutdated();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (this.AI as any).getModel !== "function") {
      try {
        const providersAll = await this.deps.importModule(path.join(this.piRoot, "node_modules/@earendil-works/pi-ai/dist/providers/all.js"));
        const models = providersAll.builtinModels();
        // providersAll / models are `any` (dynamic import), so binding their
        // methods needs no explicit annotations and preserves the instance `this`.
        this.AI = {
          ...this.AI,
          getModel: providersAll.getBuiltinModel,
          getModels: models.getModels.bind(models),
          complete: models.complete.bind(models),
        } as PiAi;
        piDebug("pi-ai >=0.80 detected — adapted AI to the providers/all entrypoint (getBuiltinModel + builtinModels()).");
      } catch (e: unknown) {
        return { success: false, error: `pi-ai >=0.80 is installed but its providers/all entrypoint could not load (${e instanceof Error ? e.message : String(e)}). Update @earendil-works/pi-coding-agent, or pin it to a 0.79.x release.` };
      }
    }

    // Load typebox for defineTool usage (with retry — npm install may still
    // be populating node_modules when the extension host first activates).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    let Type: any;
    try {
      const Typebox = await this.deps.importModule(path.join(this.piRoot, "node_modules/typebox/build/index.mjs"));
      Type = Typebox.Type ?? Typebox;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return { success: false, error: `Failed to load typebox: ${e.message ?? e}` };
    }

    const SDK = this.SDK;
    const cfg = this.deps.config();
    const cwd = this.deps.workspaceCwd();

    // ── Step 3: Model runtime (auth + models) ──────────
    // pi-coding-agent >= 0.80.8 replaced AuthStorage + ModelRegistry.create(auth) with
    // the single async ModelRuntime (0.80.8 CHANGELOG "Unified model runtime and provider
    // authentication"). It owns credentials (auth.json), the dynamic catalog, and request
    // auth; create it once and pass it to createAgentSession via the `modelRuntime` option.
    try {
      this.modelRuntime = await SDK.ModelRuntime.create();

      // Runtime API key override from VS Code secrets or env (not persisted). Now async.
      if (cfg.anthropicApiKey) {
        await this.modelRuntime.setRuntimeApiKey("anthropic", cfg.anthropicApiKey);
      }
      if (cfg.openaiApiKey) {
        await this.modelRuntime.setRuntimeApiKey("openai", cfg.openaiApiKey);
      }

      this.settingsManager = SDK.SettingsManager.create(cwd);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return { success: false, error: `Model runtime setup failed: ${e.message ?? e}` };
    }

    // ── Step 4: Pick a model (dynamic from registry) ──
    const AI = this.AI;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    let model: any = null;
    let cycleModels: Array<{ provider: string; id: string }> = [];
    try {
      // Try the runtime catalog first (respects API keys); getAvailable is async.
      const available = await this.modelRuntime.getAvailable();
      if (available.length > 0) {
        model = available[0];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        cycleModels = available.map((m: any) => ({ provider: m.provider, id: m.id }));
      } else {
        // Fallback: try built-in models via modelRuntime.getModel() (find() was removed)
        cycleModels = [];
        for (const candidate of [
          ["anthropic", "claude-sonnet-4-5"],
          ["anthropic", "claude-haiku-4-5"],
          ["openai", "gpt-4o"],
        ]) {
          const found = this.modelRuntime.getModel(candidate[0], candidate[1]);
          if (found) {
            cycleModels.push({ provider: candidate[0], id: candidate[1] });
            if (!model) { model = found; }
          }
        }
        // Try getModel for models not in registry but built-in
        if (!model) {
          for (const candidate of [
            ["anthropic", "claude-sonnet-4-5"],
            ["anthropic", "claude-haiku-4-5"],
            ["openai", "gpt-4o"],
          ]) {
            const m = AI.getModel(candidate[0], candidate[1]);
            if (m) { model = m; break; }
          }
        }
      }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return { success: false, error: `Model lookup failed: ${e.message ?? e}` };
    }

    if (!model) {
      return {
        success: false,
        error: "No model available. Set an API key (e.g. ANTHROPIC_API_KEY) and restart.",
      };
    }

    // ── Override with user's default model from VS Code settings ──
    if (cfg.defaultModelProvider && cfg.defaultModelId) {
      const defModel = this.modelRuntime.getModel(cfg.defaultModelProvider, cfg.defaultModelId) ?? AI.getModel(cfg.defaultModelProvider, cfg.defaultModelId);
      if (defModel) { model = defModel; }
    }

    // ── Override context budget from VS Code settings ──
    if (cfg.contextBudget > 0) {
      model = { ...model, contextWindow: cfg.contextBudget };
    }

    // ── Step 5: ResourceLoader ─────────────────────────
    // Builds custom system prompt, skills, context files, and prompt templates
    try {
      const DefaultResourceLoader = SDK.DefaultResourceLoader;
      const getAgentDir = SDK.getAgentDir;

      const contextFiles = buildContextFiles(cwd);
      const templates = buildPromptTemplates(SDK.createSyntheticSourceInfo);

      this.resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir: getAgentDir ? getAgentDir() : undefined,
        // Custom system prompt with VS Code context
        // Resolved lazily: systemPromptOverride is called per turn, so a model switched
        // mid-session is reflected without rebuilding the session.
        systemPromptOverride: () => buildSystemPrompt(
          this._model?.provider && this._model?.id ? { provider: this._model.provider, id: this._model.id } : null,
        ),
        // Prevent DefaultResourceLoader from appending default append files
        appendSystemPromptOverride: () => [],
        // Inject virtual context files with project-specific guidelines
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        agentsFilesOverride: (current: any) => ({
          agentsFiles: [...current.agentsFiles, ...contextFiles],
        }),
        // Inject custom slash commands
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        promptsOverride: (current: any) => ({
          prompts: [...current.prompts, ...templates],
          diagnostics: current.diagnostics,
        }),
      });
      await this.resourceLoader.reload();

      // Report discovered resources
      const { skills: discoveredSkills } = this.resourceLoader.getSkills();
      piDebug(`Extensions: ${discoveredSkills.map((s: Record<string, unknown>) => s.name).join(", ") || "none"}`);
    } catch (e: unknown) {
      piWarn(`ResourceLoader setup warning: ${e instanceof Error ? e.message : String(e)}`);
      // Non-fatal: ResourceLoader is optional, session can work without it
    }

    // ── Step 6: Session tools ──────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    let tools: any[];
    try {
      tools = [
        ...SDK.createCodingTools(cwd),
        ...this.deps.buildBridgeTools(SDK.defineTool, Type),
      ];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return { success: false, error: `Tool setup failed: ${e.message ?? e}` };
    }

    // ── Step 7: Session manager ─────────────────────
    try {
      const sessionDir = cfg.sessionDir;
      if (openPath) {
        this.sessionManager = SDK.SessionManager.open(openPath, sessionDir);
      } else if (fresh) {
        this.sessionManager = SDK.SessionManager.create(cwd, sessionDir);
        // A fresh session writes its file lazily on first persist via an
        // EXCLUSIVE open ("wx"), which throws EEXIST if the generated path
        // already exists. That collision was observed when the cwd is a shared
        // dir (e.g. no workspace folder open → process.cwd()). Regenerate until
        // the path is free so the first user message can't fail.
        for (let i = 0; i < 8; i++) {
          const f: string | undefined = this.sessionManager?.getSessionFile?.();
          if (!f || !this.deps.fileExists(f)) { break; }
          piWarn(`Fresh session path already exists, regenerating: ${f}`);
          this.sessionManager = SDK.SessionManager.create(cwd, sessionDir);
        }
      } else {
        try {
          this.sessionManager = await SDK.SessionManager.continueRecent(cwd);
        } catch {
          this.sessionManager = SDK.SessionManager.create(cwd, sessionDir);
        }
      }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return { success: false, error: `Session manager failed: ${e.message ?? e}` };
    }

    // ── Step 8: Restore model & thinking from session file (if resuming) ──
    //        Applies to both openPath (resume from Past Sessions) and
    //        continueRecent (restoring after VS Code restart).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resumeModel: any = model;
    let resumeThinkingLevel = cfg.defaultThinkingLevel;
    let foundSessionModel = false;
    let foundSessionThinking = false;
    const isResuming = !fresh && this.sessionManager;
    if (isResuming) {
      const entries = this.sessionManager.getEntries?.();
      if (Array.isArray(entries)) {
        piDebug(`Restoring model/thinking from session: ${entries.length} entries`);
        // Walk entries in reverse to find the last model_change and thinking_level_change
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i];
          if (!foundSessionModel && e.type === "model_change" && e.provider && e.modelId) {
            // Try to resolve the model from the runtime catalog
            const found = this.modelRuntime.getModel(e.provider, e.modelId);
            if (found) {
              resumeModel = found;
              foundSessionModel = true;
              piDebug(`Restored model from session: ${e.provider}/${e.modelId}`);
            } else {
              // Fallback: try getModel
              const m = AI.getModel(e.provider, e.modelId);
              if (m) {
                resumeModel = m;
                foundSessionModel = true;
                piDebug(`Restored model from session (fallback): ${e.provider}/${e.modelId}`);
              } else {
                piWarn(`Could not resolve session model: ${e.provider}/${e.modelId}`);
              }
            }
          }
          if (!foundSessionThinking && e.type === "thinking_level_change" && e.thinkingLevel) {
            resumeThinkingLevel = e.thinkingLevel;
            foundSessionThinking = true;
            piDebug(`Restored thinking from session: ${e.thinkingLevel}`);
          }
          // Stop early once both are resolved
          if (foundSessionModel && foundSessionThinking) { break; }
        }
        if (!foundSessionModel) { piDebug("No model_change entry found in session"); }
        if (!foundSessionThinking) { piDebug("No thinking_level_change entry found in session"); }
      }
    } else {
      piDebug(`Skipping session restore (fresh=${fresh}, hasSessionManager=${!!this.sessionManager})`);
    }

    // Reconcile the model's thinking capability against the authoritative bundled
    // catalog FIRST, so a custom ~/.pi/agent/models.json that omits `reasoning` can't
    // make a known-reasoning model look non-reasoning. Upgrade resumeModel IN PLACE so
    // both our clamp below AND the SDK's own clamp (createAgentSession → sdk.js
    // clampThinkingLevel(model, level), and getSupportedThinkingLevels(this.model) for
    // the picker) see reasoning:true — otherwise the default level (e.g. xhigh) silently
    // clamps to "off" at session open.
    const catalog = this.deps.catalogProviders();
    if (resumeModel?.provider && resumeModel?.id) {
      resumeModel = reconcileThinkingCapability(catalog, resumeModel.provider, resumeModel.id, resumeModel);
      // Restore cost rates too: a stripped ~/.pi/agent/models.json entry that omits
      // `cost` makes the SDK default it to zeros, so pi-ai's calculateCost yields
      // exactly $0 (model.cost.input/1e6 × tokens) and the status bar hides cost. The
      // catalog carries the model owner's published rates. Only fill when absent/zero.
      if (!resumeModel.cost?.input) {
        const realCost = findCatalogModelCost(catalog, resumeModel.provider, resumeModel.id);
        if (realCost) { resumeModel = { ...resumeModel, cost: realCost }; }
      }
    }
    // Clamp the resolved level (default config, or restored session level) to what
    // the chosen model actually honors, so the session never STARTS at a level the
    // model would silently ignore — e.g. a saved default of "low" on DeepSeek snaps
    // to "high". resumeModel carries reasoning + thinkingLevelMap; clampThinkingLevel
    // mirrors pi-ai's own clamping, so what we send and store is what's real.
    const clampedThinking = clampThinkingLevel(resumeModel as ThinkingModel, resumeThinkingLevel);
    if (clampedThinking !== resumeThinkingLevel) {
      piDebug(`Clamped thinking ${resumeThinkingLevel} → ${clampedThinking} for ${resumeModel?.id ?? "model"}`);
      resumeThinkingLevel = clampedThinking;
    }

    // ── Step 9: Create agent session ───────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any;
    try {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sessionOpts: any = {
        model: resumeModel,
        thinkingLevel: resumeThinkingLevel,
        modelRuntime: this.modelRuntime,
        settingsManager: this.settingsManager,
        sessionManager: this.sessionManager,
        customTools: tools,
        cwd,
      };

      // Scoped models from registry (dynamic)
      if (cycleModels.length > 0) {
        sessionOpts.scopedModels = cycleModels.map((m) => ({
          model: AI.getModel(m.provider, m.id),
          thinkingLevel: "off",
        }));
      }

      // ResourceLoader with custom system prompt, context files, templates
      if (this.resourceLoader) {
        sessionOpts.resourceLoader = this.resourceLoader;
      }

      // Inject before extensions load (SDK may load them during createAgentSession).
      //
      // TRUST BOUNDARY. Whatever a pi extension passes here is injected into the webview as a
      // <script> carrying the CSP nonce and executed — i.e. arbitrary JS in the webview, which is
      // the one thing the nonce-based CSP otherwise prevents. A pi extension already runs
      // arbitrary code in the extension host, so this is not an escalation FOR a trusted
      // extension; the danger is that the payload travels over the message bus, so any future
      // path that lets model or remote content reach this handler becomes a full compromise.
      //
      // Gated on explicit, remembered user consent per (extension-ish) custom type, so source
      // never reaches the webview unless the user said yes at least once.
      (globalThis as Record<string, unknown>).__piRegisterMessageRenderer = (customType: string, sourceCode: string) => {
        void (async () => {
          if (!(await this.deps.confirmRendererConsent(customType))) {
            piWarn(`Custom renderer for "${customType}" was not allowed — rendering falls back to markdown.`);
            return;
          }
          this.host.emit({ type: "registerMessageRenderer", data: { customType, sourceCode } });
        })();
      };

      result = await SDK.createAgentSession(sessionOpts);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return { success: false, error: `createAgentSession failed: ${e.message ?? e}` };
    }

    this.session = result.session;
    // Own the active model identity (read by PiService via getModel()); the outcome still
    // carries it for the caller's other post-init wiring.
    this._model = { id: resumeModel.id, name: resumeModel.name, provider: resumeModel.provider };
    this._thinkingLevel = resumeThinkingLevel;

    return {
      success: true,
      model: this._model,
      cycleModels,
      thinkingLevel: resumeThinkingLevel,
      isResuming: !!isResuming,
    };
  }

  /** Once-per-host nudge when the installed pi-ai predates the version this
   *  extension targets. We still run on older SDKs (legacy getModel path), but the
   *  0.80 model-API redesign is what we're built against, so nudge the user. */
  private async warnIfPiAiOutdated(): Promise<void> {
    if (_piAiVersionWarned || !this.piRoot) { return; }
    try {
      const pkgPath = path.join(this.piRoot, "node_modules", "@earendil-works", "pi-ai", "package.json");
      const installed = (JSON.parse(await this.deps.readFileUtf8(pkgPath)) as { version?: string }).version ?? "";
      if (!installed) { return; }
      // TWO tiers. This used to test the FLOOR only, so anyone at 0.80.0+ was never told
      // anything however far behind they drifted — a user sitting on 0.82.1 while the
      // extension shipped a 0.83.0 catalog heard nothing at all.
      const notice = piAiVersionNotice(installed, SUPPORTED_PI_AI_VERSION, TARGET_PI_AI_VERSION);
      if (!notice) { return; }
      _piAiVersionWarned = true;
      piWarn(`pi-ai ${installed} is ${notice.belowFloor ? `below the supported floor ${notice.version}` : `behind this build's target ${notice.version}`}.`);
      this.deps.notifyOutdatedPiAi(installed, notice.version, notice.belowFloor);
    } catch (e: unknown) {
      piWarn(`pi-ai version check skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── PiBackend primitive operations (delegated from PiService) ──
  // The TS-runtime halves of the per-method runtime split: the raw session
  // operations, with orchestration + UI (slash interception, vision auto-switch,
  // pickers, status formatting, cost policy) staying in PiService. RustService
  // implements the same PiBackend surface for the out-of-process runtime.
  /* eslint-disable @typescript-eslint/no-explicit-any -- dynamically typed SDK session objects */

  /** Send a user turn / steer / follow-up on the in-process session. Slash-command
   *  interception and image/vision auto-switch are PiService orchestration and run
   *  before this call; here we only drive session.prompt / steer / followUp. */
  async sendPrompt(text: string, images?: any[], mode?: string): Promise<void> {
    if (!this.session) { throw new Error("Pi session not initialized"); }
    if (mode === "steer" || mode === "queue") {
      if (images && images.length > 0) { throw new Error("Cannot attach images while agent is streaming"); }
      try {
        if (mode === "queue") { await this.session.followUp(text); }
        else { await this.session.steer(text); }
      } catch (e: any) {
        // steer/followUp reject extension commands and prompt templates during
        // streaming — surface the error rather than swallowing it.
        const msg = e?.message ?? String(e);
        piWarn(`sendPrompt ${mode} failed: ${msg}`);
        const friendly = humanizeProviderError(msg);
        this.host.emit({ type: "custom-message", data: { customType: "error", content: friendly ?? `${mode === "steer" ? "Steer" : "Queue"} failed: ${msg}`, timestamp: Date.now() } });
      }
      return;
    }
    const opts: any = {};
    if (images && images.length > 0) { opts.images = images; }
    await this.session.prompt(text, opts);
  }

  /** Abort the in-flight LLM turn — killing running bash first (agent.abort() only
   *  stops the LLM call, not child processes, which would otherwise orphan). */
  abort(): void {
    if (!this.session) { piWarn("abort() called but session not initialized — nothing to abort"); return; }
    try { this.session.abortBash?.(); } catch (e: any) { piWarn(`abortBash() failed: ${e?.message ?? e}`); }
    try { this.session.agent.abort(); } catch (e: any) { piWarn(`abort() failed: ${e?.message ?? e}`); }
  }

  /** Abort a running bash tool only (the LLM turn keeps going). */
  abortBash(): void {
    try { this.session?.abortBash?.(); } catch (e: any) { piWarn(`abortBash() failed: ${e?.message ?? e}`); }
  }

  /** Compact the conversation context via the in-process SDK session (the same call
   *  the command-palette `pi-code-gui.compact` uses). */
  async compact(): Promise<void> {
    try { await this.session?.compact?.(); } catch (e: any) { piWarn(`compact() failed: ${e?.message ?? e}`); }
  }

  /** Set the active model on the session. Resolves the model from the registry (then
   *  the pi-ai catalog), applies it, and returns the applied identity — or null when
   *  the session isn't ready or the model can't be resolved (caller then bails). */
  async setModel(provider: string, id: string): Promise<{ id?: string; name?: string; provider?: string } | null> {
    if (!this.session || !this.AI) { piWarn(`setModel("${provider}/${id}") ignored: session not initialized`); return null; }
    // Try the runtime catalog first, then fall back to pi-ai getModel.
    let model: any = null;
    if (this.modelRuntime) { model = this.modelRuntime.getModel(provider, id); }
    if (!model) { model = this.AI.getModel(provider, id); }
    if (!model) { return null; }
    // Re-apply the context budget, exactly as initialize() does. Without this the budget was a
    // one-shot: it governed the model chosen at startup and then silently stopped applying the
    // moment the user switched models mid-session, because the SDK reads model.contextWindow for
    // BOTH the auto-compaction trigger and the context-% denominator. The Rust path has no such
    // gap — applyState re-clamps on every get_state — so the same action produced a clamped
    // readout on one runtime and an unclamped one on the other.
    const budget = this.deps.config().contextBudget;
    if (budget > 0) { model = { ...model, contextWindow: budget }; }
    await this.session.setModel(model);
    this._model = { id, provider };  // owned here; PiService reads via getModel()
    // No force-persist here: session.setModel() already records a model_change via the
    // SDK's appendModelChange (deferred, flushed with the session header on the first
    // assistant message). A direct write would duplicate it AND create the file early,
    // breaking the SDK's exclusive-create flush (EEXIST on first prompt).
    return { id, provider };
  }

  /** Set the thinking level on the session. The SDK records the CLAMPED effective
   *  level itself (appendThinkingLevelChange); we echo the requested level back for
   *  PiService's shared state (the TS transport always transmits it). */
  async setThinkingLevel(level: string): Promise<string> {
    if (!this.session) { piWarn(`setThinkingLevel("${level}") ignored: session not initialized`); return level; }
    this.session.setThinkingLevel(level);
    this._thinkingLevel = level;  // owned here; PiService reads via getThinkingLevel()
    return level;
  }

  /** The active thinking level (owned here; PiService reads it via the seam). */
  getThinkingLevel(): string { return this._thinkingLevel; }
  /** Sync the stored level from a streamed thinking_level_changed echo (no wire call). */
  applyThinkingLevel(level: string): void { this._thinkingLevel = level; }

  // Run/streaming flags — owned by the backend (PiService applies them from the event stream
  // via these setters and reads via the getters). The SDK doesn't read them itself.
  private _agentRunActive = false;
  private _isStreaming = false;
  getAgentRunActive(): boolean { return this._agentRunActive; }
  setAgentRunActive(v: boolean): void { this._agentRunActive = v; }
  isStreaming(): boolean { return this._isStreaming; }
  setStreaming(v: boolean): void { this._isStreaming = v; }

  /** Toggle auto-compaction on the session (if the SDK build exposes the setter). */
  /** The SDK session reloads extensions/skills/context files in place. */
  async reloadContext(): Promise<boolean> {
    if (!this.session?.reload) { return false; }
    await this.session.reload();
    return true;
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    if (this.session && typeof this.session.setAutoCompactionEnabled === "function") {
      await this.session.setAutoCompactionEnabled(enabled);
    }
  }

  /** Auto-retry has no in-process SDK session toggle — PiService tracks the flag
   *  locally. Kept for PiBackend symmetry (a no-op on the TS runtime). */
  async setAutoRetry(enabled: boolean): Promise<void> {
    // The SDK DOES expose this (AgentSession.setAutoRetryEnabled → SettingsManager.setRetryEnabled);
    // it simply was never wired, so the settings toggle flipped an extension-local flag, told the
    // webview it had changed, and left the session retrying exactly as before. Same guarded shape
    // as setAutoCompaction, so an older SDK without the method degrades instead of throwing.
    if (this.session && typeof this.session.setAutoRetryEnabled === "function") {
      await this.session.setAutoRetryEnabled(enabled);
    }
  }

  /** The session's ACTUAL settings, for seeding the UI at init.
   *
   *  PiService previously hardcoded both to `true` and never read them back, so a resumed
   *  session whose settings differed showed toggles that disagreed with its own behaviour. The
   *  Rust path never had this gap — applyState syncs both from get_state. Undefined when the
   *  SDK predates the getters, so the caller keeps its default rather than inventing one. */
  readSessionSettings(): { autoCompaction?: boolean; autoRetry?: boolean } {
    const s = this.session;
    if (!s) { return {}; }
    return {
      autoCompaction: typeof s.autoCompactionEnabled === "boolean" ? s.autoCompactionEnabled : undefined,
      autoRetry: typeof s.autoRetryEnabled === "boolean" ? s.autoRetryEnabled : undefined,
    };
  }

  /** Cumulative token/cost usage from the session manager's assistant entries, plus
   *  live context %/window. Cost here is the SDK's own per-turn cost; the catalog-rate
   *  fallback + costKnown policy stay in PiService.getUsageStats. */
  getUsage(): BackendUsage {
    if (!this.sessionManager) { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextPercent: null, contextWindow: 0 }; }
    const entries = this.sessionManager.getEntries();
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
    for (const entry of entries) {
      if (entry.type === "message" && entry.message?.role === "assistant") {
        const usage = entry.message.usage;
        if (usage) {
          input += usage.input ?? 0;
          output += usage.output ?? 0;
          cacheRead += usage.cacheRead ?? 0;
          cacheWrite += usage.cacheWrite ?? 0;
          cost += usage.cost?.total ?? 0;
        }
      }
    }
    let contextPercent: number | null = null;
    let contextWindow = 0;
    try {
      const contextUsage = this.session?.getContextUsage?.();
      if (contextUsage) { contextPercent = contextUsage.percent; contextWindow = contextUsage.contextWindow; }
    } catch (e: unknown) { piWarn(`Non-critical failure (ignored): ${e instanceof Error ? e.message : String(e)}`); }
    return { input, output, cacheRead, cacheWrite, cost, contextPercent, contextWindow };
  }

  /** Session entries for the Open Sessions tree (display only). */
  getEntries(): any[] { return this.sessionManager?.getEntries?.() ?? []; }

  /** The TS runtime's own slash commands: extension-registered commands (introspected
   *  from the session's extension runner) + the builtin VS Code prompt templates. Rust
   *  supplies its equivalents over RPC; PiService appends the shared GUI/capability set. */
  getSlashCommands(): Array<{ cmd: string; desc: string; source: string }> {
    const result: Array<{ cmd: string; desc: string; source: string }> = [];
    try {
      const runner = this.session?._extensionRunner;
      if (runner && typeof runner.getRegisteredCommands === "function") {
        const commands = runner.getRegisteredCommands();
        if (commands && commands.length > 0) {
          for (const c of commands) {
            const source = c?.sourceInfo?.source ? `extension (${c.sourceInfo.source})` : "extension";
            result.push({ cmd: `/${c.invocationName}`, desc: c.description ?? "", source });
          }
        }
      }
    } catch (e: unknown) { piWarn(`Best-effort failure: ${e instanceof Error ? e.message : String(e)}`); }
    // Builtin prompt templates are TS-SDK-registered (Rust supplies its own via get_commands).
    result.push(
      { cmd: "/fix-diagnostics", desc: "Fix all diagnostics in open file", source: "builtin" },
      { cmd: "/explain-code", desc: "Explain the code at current cursor position", source: "builtin" },
      { cmd: "/refactor", desc: "Refactor the selected code", source: "builtin" },
    );
    return result;
  }

  /** The active model identity (owned here; PiService reads it via the seam). */
  getModel(): { id?: string; name?: string; provider?: string; api?: string; reasoning?: boolean } | null { return this._model; }

  /** Models available for /model — from the ModelRuntime's auth-filtered catalog. */
  async getAvailableModels(): Promise<Array<{ provider: string; id: string; name?: string; cost?: { input: number; output: number }; contextWindow?: number }>> {
    if (!this.modelRuntime) { return []; }
    try {
      const available = await this.modelRuntime.getAvailable();
      return available.map((m: any) => ({
        provider: m.provider,
        id: m.id,
        name: m.name,
        cost: m.cost ? { input: m.cost.input, output: m.cost.output } : undefined,
        contextWindow: m.contextWindow ?? undefined,
      }));
    } catch {
      return [];
    }
  }

  /** Promote a queued follow-up to a steering message: re-queue the existing steers,
   *  then append the promoted text (the SDK has no in-place promote). */
  promoteToSteer(text: string): void {
    if (!this.session) { return; }
    const existingSteer = this.session.getSteeringMessages ? [...this.session.getSteeringMessages()] : [];
    this.session.clearQueue();
    for (const m of existingSteer) { this.session.steer(m); }
    this.session.steer(text);
  }

  /** Clear the pending steer/follow-up queue on the session. */
  clearQueue(): void { this.session?.clearQueue?.(); }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  /** Export the conversation to HTML via the in-process SDK session. */
  async exportToHtml(outputPath: string): Promise<string> {
    if (!this.session) { throw new Error("No active session to export."); }
    return this.session.exportToHtml(outputPath);
  }

  /** Drop all SDK references. The owner (PiService.dispose) has already
   *  unsubscribed listeners and disposed the session itself. */
  dispose(): void {
    this.session = null;
    this.sessionManager = null;
    this.resourceLoader = null;
    this.modelRuntime = null;
    this.settingsManager = null;
    this.SDK = null;
    this.AI = null;
    this.piRoot = null;
  }
}
