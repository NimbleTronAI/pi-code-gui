import * as path from "node:path";
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import * as vscode from "vscode";
import { createBridgeTools } from "./bridge-tools.js";
import { splitEditorContext } from "./editor-context.js";
import { findHistoryPageStart, isVisibleHistoryEntry } from "./history-pagination.js";
import { buildScopedModels, completeWithModelRuntime, getRuntimeModel, selectInitialModel } from "./pi-model-runtime.js";
import { buildConversationTurnPreviews } from "./conversation-turns.js";
import { type ImageContent, type PiServiceEvent, validateExtensionToWebview } from "./types.js";
import { piLog, piWarn } from "./logger.js";
import { getWorkspaceCwd, getWorkspaceUri } from "./workspace-context.js";
import { readProviderApiKey } from "./provider-credentials.js";
import { formatLineChangeSummary } from "./tool-change-summary.js";

/** Find the last element matching predicate (ES2023 findLast polyfill). */
function reverseFind<T>(arr: T[], pred: (el: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) { return arr[i]; }
  }
  return undefined;
}

export interface LoadedExtension {
  name: string;
  path: string;
}

export interface LoadedSkill {
  name: string;
  description: string;
  path: string;
  scope?: "user" | "project" | "temporary";
}

export interface SlashCommandInfo {
  cmd: string;
  desc: string;
  source: "builtin" | "extension" | "prompt" | "skill";
  scope?: "user" | "project" | "temporary";
}

function extensionDisplayName(extensionPath: string): string {
  const parts = extensionPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const nodeModulesIndex = parts.lastIndexOf("node_modules");
  if (nodeModulesIndex >= 0) {
    const packageName = parts[nodeModulesIndex + 1];
    if (packageName?.startsWith("@") && parts[nodeModulesIndex + 2]) {
      return `${packageName}/${parts[nodeModulesIndex + 2]}`;
    }
    if (packageName) { return packageName; }
  }

  const fileName = parts.at(-1) ?? extensionPath;
  const stem = fileName.replace(/\.[^.]+$/, "");
  if (stem === "index" && parts.length > 1) {
    return parts[parts.length - 2];
  }
  return stem || fileName;
}

/**
 * Dynamic import with retry — handles the race where npm is still populating
 * node_modules when the extension host first activates.
 */
async function importWithRetry(
  modulePath: string,
  maxAttempts: number,
  delayMs: number,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const target = process.platform === "win32"
        ? pathToFileURL(modulePath).href
        : modulePath;
      return await import(target);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (attempt === maxAttempts) { throw e; }
      piWarn(`importWithRetry: attempt ${attempt}/${maxAttempts} failed for ${modulePath}: ${e.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// ── Types for the dynamically loaded SDK ──────────────────

/* eslint-disable @typescript-eslint/no-explicit-any -- dynamically imported SDK; types unavailable at compile time */
interface PiSdk {
  createAgentSessionFromServices: Function;
  createAgentSessionServices: Function;
  SessionManager: any;
  SettingsManager: any;
  ModelRuntime: any;
  ModelRegistry: any;
  createCodingTools: Function;
  createReadOnlyTools: Function;
  DefaultResourceLoader: any;
  defineTool: Function;
  getAgentDir: Function;
  createSyntheticSourceInfo: Function;
}

export interface InstallStatus {
  installed: boolean;
  hasApiKey: boolean;
  path?: string;
  error?: string;
}

/* eslint-enable @typescript-eslint/no-explicit-any */
type EventListener = (event: PiServiceEvent) => void;

// ── SDK Resolution ───────────────────────────────────────

export function resolvePiPackagePath(): string {
  const pkgSuffix = path.join("node_modules", "@earendil-works", "pi-coding-agent");
  const candidates: Set<string> = new Set();

  // 1. Project-local install
  candidates.add(path.resolve(path.join(".pi", "npm", pkgSuffix)));

  // 2. Universal PATH scan — derive npm global prefixes from $PATH entries
  const pathEnv = process.env.PATH || "";
  const separator = process.platform === "win32" ? ";" : ":";
  const seenPrefixes = new Set<string>();
  for (const binDir of pathEnv.split(separator)) {
    if (!binDir) { continue; }
    let normBin = path.normalize(binDir);
    if (normBin.endsWith(path.sep)) { normBin = normBin.slice(0, -1); }
    const prefix = path.dirname(normBin);
    if (seenPrefixes.has(normBin)) { continue; }
    seenPrefixes.add(normBin);
    candidates.add(path.join(prefix, "lib", pkgSuffix));
    if (process.platform === "win32") {
      candidates.add(path.join(prefix, pkgSuffix));
      // nvm4w: PATH entry IS the node dir containing node_modules directly
      candidates.add(path.join(normBin, pkgSuffix));
    }
  }


  // 3. Windows AppData (npm default on Windows)
  const appData = process.env.APPDATA || "";
  if (appData) {
    candidates.add(path.join(appData, "npm", pkgSuffix));
  }


  // 4. Legacy hardcoded fallbacks (for GUI-launched VS Code with incomplete $PATH)
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home) {
    candidates.add(path.join(home, ".npm-global", "lib", pkgSuffix));
    candidates.add(path.join(home, ".local", "lib", pkgSuffix));
  }
  if (process.env.NVM_DIR) {
    try {
      const versionsDir = path.join(process.env.NVM_DIR, "versions", "node");
      if (fs.existsSync(versionsDir)) {
        for (const version of fs.readdirSync(versionsDir)) {
          candidates.add(path.join(versionsDir, version, "lib", pkgSuffix));
        }
      }
    } catch (e: unknown) { piWarn(`Non-critical failure (ignored): ${e instanceof Error ? e.message : String(e)}`); }
  }

  for (const candidate of candidates) {
    try {
      const pkgPath = path.join(candidate, "package.json");
      if (fs.existsSync(pkgPath)) { return candidate; }
    } catch (e: unknown) { piWarn(`Non-critical failure (ignored): ${e instanceof Error ? e.message : String(e)}`); }
  }

  throw new Error(
    "Pi coding agent SDK not found. Please install it:\n" +
      "  npm install -g @earendil-works/pi-coding-agent",
  );
}

// ── System Prompt ────────────────────────────────────────

/** Build the VS Code-aware system prompt */
function buildSystemPrompt(additionalInstructions = ""): string {
  const basePrompt = `You are a coding assistant running inside VS Code through the Pi on Code extension.
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
  const appended = additionalInstructions.trim();
  return appended ? `${basePrompt}\n\nAdditional user instructions:\n${appended}` : basePrompt;
}

// ── Context Files ────────────────────────────────────────

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

## Running in Pi on Code
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

// ── Prompt Templates ─────────────────────────────────────

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

interface RemoteCustomUiComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate?(): void;
  dispose?(): void;
}

type RemoteCustomUiAnchor =
  | "center" | "top-left" | "top-right" | "bottom-left" | "bottom-right"
  | "top-center" | "bottom-center" | "left-center" | "right-center";

interface RemoteCustomUiEntry {
  component: RemoteCustomUiComponent | null;
  width: number;
  overlay: boolean;
  anchor: RemoteCustomUiAnchor;
  maxHeight?: number | string;
  lastFrame: string | null;
  opened: boolean;
  settled: boolean;
  finish(value: unknown): void;
}

interface RemoteCustomUiOverlayOptions {
  width?: number | string;
  maxHeight?: number | string;
  anchor?: RemoteCustomUiAnchor;
}

interface RemoteCustomUiOptions {
  overlay?: boolean;
  overlayOptions?: RemoteCustomUiOverlayOptions | (() => RemoteCustomUiOverlayOptions);
}

type RemoteCustomUiFactory = (
  tui: { requestRender(): void },
  theme: Record<string, unknown>,
  keybindings: { matches(data: string, keybinding: string): boolean },
  done: (value: unknown) => void,
) => RemoteCustomUiComponent | Promise<RemoteCustomUiComponent>;

// ── PiService ────────────────────────────────────────────

export class PiService {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  private session: any = null;
  private unsubscribe: (() => void) | null = null;
  private listeners: EventListener[] = [];
  private _model: { id?: string; name?: string; provider?: string } | null = null;
  private _thinkingLevel = "off";
  private _effort = "auto";
  private _isStreaming = false;
  private sessionId: string | null = null;

  // SDK root path (for re-importing individual modules)
  private _piRoot: string | null = null;

  // SDK instances (loaded at init time)
  /* eslint-disable @typescript-eslint/no-explicit-any -- SDK objects are dynamically typed */
  private SDK: PiSdk | null = null;
  private modelRuntime: any = null;
  private modelRegistry: any = null;
  private settingsManager: any = null;
  private sessionManager: any = null;
  private resourceLoader: any = null;

  // Model cycling state (populated dynamically from registry)
  private cycleModels: Array<{ provider: string; id: string }> = [];
  private cycleIndex = 0;

  // Track current assistant message content (for toolCall stubs during message_update)
  private currentAssistantToolCalls: Map<string, { toolName: string; toolCallId: string; args: any }> = new Map();
  private writeChanges = new Map<string, { before: string; after: string }>();

  // Widget activity timer (cleared on dispose to prevent leaks)
  private _widgetTimer: ReturnType<typeof setInterval> | null = null;

  /* eslint-enable @typescript-eslint/no-explicit-any */

  // Pending interactive dialogs (select/confirm/input).  Maps dialog ID → Promise resolve.
  private _pendingDialogs = new Map<string, { resolve: (v: unknown) => void }>();

  // Focused TUI components whose text frames are rendered by the Webview.
  private _customUis = new Map<string, RemoteCustomUiEntry>();

  // Turn tracking (like AgentSession._turnIndex in the SDK)
  private turnIndex = 0;

  // User message history for the resend/reuse feature (#2)
  private _userMessages: Array<{ id: string; text: string; timestamp?: number }> = [];

  // Lazily replayed session history. The cursor points to the oldest entry
  // currently rendered in the Webview.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  private historyEntries: any[] = [];
  private historyCursor = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  private historyToolResultsById = new Map<string, any>();
  private historyPageLoading = false;
  private historyReplayCollector: PiServiceEvent[] | null = null;
  private initialHistoryReplayEvents: PiServiceEvent[] = [];
  private capturingInitialHistoryReplay = false;

  // Settings state (#3)
  private _autoCompactionEnabled = true;
  private _autoRetryEnabled = true;
  private _showImages = true;

  constructor(private readonly secrets?: vscode.SecretStorage) {}

  // ── Public API ─────────────────────────────────────────

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: PiServiceEvent): void {
    // ── Layer 1: Runtime protocol validation ───────────────
    // Validates every outgoing message against the Zod schema.
    // If validation fails, we STILL emit to avoid breaking existing
    // functionality, but log the error and show a diagnostic notification.
    const result = validateExtensionToWebview(event);
    if (!result.success) {
      piWarn(`[protocol] emit validation failed for type "${(event as Record<string, unknown>).type}": ${result.error}`);
      // Emit a visible diagnostic so the user (and us) can see the issue
      this.emitSafe({
        type: "custom-message",
        data: {
          customType: "pi-on-code-diagnostic",
          content: `Protocol validation error (type: ${(event as Record<string, unknown>).type}): ${result.error.substring(0, 200)}`,
          display: false,
        },
      });
    }
    if (this.capturingInitialHistoryReplay) {
      this.initialHistoryReplayEvents.push(event);
    }
    if (this.historyReplayCollector) {
      this.historyReplayCollector.push(event);
      return;
    }

    // Dispatch to listeners (always, even on validation failures for backward compat)
    for (const l of this.listeners) {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      try { l(event); } catch (e: any) {
        piWarn(`emit listener threw for type "${(event as Record<string, unknown>).type}": ${e?.message ?? e}`);
      }
    }
  }

  /** Emit without validation (used internally to avoid recursive validation on diagnostics). */
  private emitSafe(event: PiServiceEvent): void {
    for (const l of this.listeners) {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      try { l(event); } catch (e: any) {
        piWarn(`emitSafe listener threw for type "${(event as Record<string, unknown>).type}": ${e?.message ?? e}`);
      }
    }
  }

  static async checkInstall(): Promise<InstallStatus> {
    try {
      const p = resolvePiPackagePath();

      // Verify critical transitive dependencies are actually present (not just
      // package.json stubs — npm global install hoisting can leave hollow dirs).
      const missing: string[] = [];
      const criticalDeps: Array<[string, string]> = [
        ["openai", "index.js"],
        ["@anthropic-ai/sdk", "index.mjs"],
      ];
      for (const [dep, entry] of criticalDeps) {
        const candidate = path.join(p, "node_modules", dep, entry);
        if (!fs.existsSync(candidate)) {
          // Also check top-level hoist (npm global installs sometimes hoist to
          // the global node_modules directly).
          const globalCandidate = path.join(p, "..", "..", dep, entry);
          if (!fs.existsSync(globalCandidate)) {
            missing.push(dep);
          }
        }
      }

      if (missing.length > 0) {
        return {
          installed: false,
          hasApiKey: false,
          error:
            `Pi SDK found but dependencies are missing: ${missing.join(", ")}. ` +
            `Reinstall with: npm uninstall -g @earendil-works/pi-coding-agent && npm install -g @earendil-works/pi-coding-agent`,
        };
      }

      return { installed: true, hasApiKey: true, path: p };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return { installed: false, hasApiKey: false, error: e.message ?? String(e) };
    }
  }

  /** List past (saved-on-disk) sessions for the given cwd. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  static async listSessions(cwd: string): Promise<any[]> {
    try {
      const piRoot = resolvePiPackagePath();
      // Match initialize()'s retry parameters — fewer retries here
      // caused past-session lists to come up empty on slow first loads.
      const SDK = await importWithRetry(path.join(piRoot, "dist/index.js"), 5, 500);
      const cfg = vscode.workspace.getConfiguration("pi-on-code");
      const sessionDir = cfg.get<string>("sessionDir")?.trim() || undefined;
      const sessions = await SDK.SessionManager.list(cwd, sessionDir);
      piLog(`listSessions: found ${sessions.length} past sessions in ${cwd}`);
      return sessions;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      piWarn(`listSessions failed: ${e.message ?? e}`);
      return [];
    }
  }

  /** Delete a session file from disk. */
  static async deleteSessionFile(filePath: string): Promise<void> {
    if (typeof filePath !== "string") {
      throw new Error("deleteSessionFile: filePath must be a string");
    }
    await fs.promises.unlink(filePath);
  }

  async initialize(opts?: { fresh?: boolean; openPath?: string; cwd?: string }): Promise<{ success: boolean; error?: string }> {
    const fresh = opts?.fresh ?? false;
    const openPath = opts?.openPath ?? null;
    // ── Step 1: Resolve SDK ────────────────────────────
    try {
      this._piRoot = resolvePiPackagePath();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return { success: false, error: `SDK not found: ${e.message ?? e}` };
    }

    // ── Step 2: Load SDK modules ───────────────────────
    try {
      this.SDK = (await importWithRetry(
        path.join(this._piRoot, "dist/index.js"), 5, 500
      )) as PiSdk;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return { success: false, error: `Failed to load pi-coding-agent: ${e.message ?? e}` };
    }

    // Load typebox for defineTool usage (with retry — npm install may still
    // be populating node_modules when the extension host first activates).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    let Type: any;
    try {
      const Typebox = await importWithRetry(
        path.join(this._piRoot, "node_modules/typebox/build/index.mjs"),
        5,  // max attempts
        500 // delay ms between attempts
      );
      Type = Typebox.Type ?? Typebox;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return { success: false, error: `Failed to load typebox: ${e.message ?? e}` };
    }

    const SDK = this.SDK;
    const cwd = opts?.cwd ?? getWorkspaceCwd();

    // ── Step 3: Runtime settings and SDK services ──────
    // Provider extensions must be loaded before resolving defaults. In SDK 0.80
    // createAgentSessionServices() applies pending registerProvider() calls and
    // refreshes ModelRuntime before returning.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    let services: any;
    try {
      this.modelRuntime = await SDK.ModelRuntime.create();

      // Runtime API key overrides are stored in VS Code SecretStorage. Values
      // from pre-0.2.0 settings are migrated on first use.
      const config = vscode.workspace.getConfiguration("pi-on-code");
      const reportCredentialMigrationError = (error: unknown): void => {
        piWarn(`Could not migrate legacy API key setting: ${error instanceof Error ? error.message : String(error)}`);
      };
      const anthropicKey = await readProviderApiKey(
        this.secrets, config, "anthropic", reportCredentialMigrationError,
      );
      if (anthropicKey) {
        await this.modelRuntime.setRuntimeApiKey("anthropic", anthropicKey);
      }
      const openaiKey = await readProviderApiKey(
        this.secrets, config, "openai", reportCredentialMigrationError,
      );
      if (openaiKey) {
        await this.modelRuntime.setRuntimeApiKey("openai", openaiKey);
      }

      const enableSkills = config.get<boolean>("enableSkills", true);
      const enableContextFiles = config.get<boolean>("enableContextFiles", true);
      const enablePromptTemplates = config.get<boolean>("enablePromptTemplates", true);
      const systemPromptAppend = config.get<string>("systemPromptAppend", "");

      this.settingsManager = SDK.SettingsManager.create(cwd);
      const contextFiles = enableContextFiles ? buildContextFiles(cwd) : [];
      const templates = enablePromptTemplates
        ? buildPromptTemplates(SDK.createSyntheticSourceInfo)
        : [];
      services = await SDK.createAgentSessionServices({
        cwd,
        modelRuntime: this.modelRuntime,
        settingsManager: this.settingsManager,
        resourceLoaderOptions: {
          noSkills: !enableSkills,
          noContextFiles: !enableContextFiles,
          noPromptTemplates: !enablePromptTemplates,
          systemPromptOverride: () => buildSystemPrompt(systemPromptAppend),
          appendSystemPromptOverride: () => [],
// eslint-disable-next-line @typescript-eslint/no-explicit-any
          agentsFilesOverride: (current: any) => ({
            agentsFiles: [...current.agentsFiles, ...contextFiles],
          }),
// eslint-disable-next-line @typescript-eslint/no-explicit-any
          promptsOverride: (current: any) => ({
            prompts: [...current.prompts, ...templates],
            diagnostics: current.diagnostics,
          }),
        },
      });
      this.modelRuntime = services.modelRuntime;
      this.settingsManager = services.settingsManager;
      this.resourceLoader = services.resourceLoader;
      this.modelRegistry = new SDK.ModelRegistry(this.modelRuntime);
      for (const diagnostic of services.diagnostics ?? []) {
        const message = `SDK service ${diagnostic.type}: ${diagnostic.message}`;
        diagnostic.type === "error" ? piWarn(message) : piLog(message);
      }
      const { skills: discoveredSkills } = this.resourceLoader.getSkills();
      piLog(`Skills: ${discoveredSkills.map((s: Record<string, unknown>) => s.name).join(", ") || "none"}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return { success: false, error: `Runtime service setup failed: ${e.message ?? e}` };
    }

    // ── Step 4: Pick a model after providers are registered ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    let model: any = null;
    const cfg = vscode.workspace.getConfiguration("pi-on-code");
    try {
      const available = await this.modelRuntime.getAvailable();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.cycleModels = available.map((m: any) => ({ provider: m.provider, id: m.id }));
      const defProvider = cfg.get<string>("defaultModelProvider")?.trim();
      const defModelId = cfg.get<string>("defaultModelId")?.trim();
      const piProvider = this.settingsManager.getDefaultProvider?.();
      const piModelId = this.settingsManager.getDefaultModel?.();
      model = selectInitialModel(this.modelRuntime, available, {
        guiDefault: defProvider && defModelId ? { provider: defProvider, id: defModelId } : undefined,
        piDefault: piProvider && piModelId ? { provider: piProvider, id: piModelId } : undefined,
      });
      if (defProvider && defModelId && (model?.provider !== defProvider || model?.id !== defModelId)) {
        piWarn(`Configured GUI default model is unavailable: ${defProvider}/${defModelId}`);
      }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return { success: false, error: `Model lookup failed: ${e.message ?? e}` };
    }

    if (!model) {
      return {
        success: false,
        error: "No model available. Configure a provider/API key and restart.",
      };
    }

    const contextBudget = cfg.get<number>("contextBudget") ?? 0;
    if (contextBudget > 0) {
      model = { ...model, contextWindow: contextBudget };
    }
    this._model = { id: model.id, name: model.name, provider: model.provider };
    piLog(`Initial model: ${model.provider}/${model.id}`);

    // ── Step 6: Session tools ──────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    let tools: any[];
    try {
      tools = [
        ...SDK.createCodingTools(cwd),
        ...createBridgeTools(SDK.defineTool, Type),
      ];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return { success: false, error: `Tool setup failed: ${e.message ?? e}` };
    }

    // ── Step 7: Session manager ─────────────────────
    try {
      const cfg = vscode.workspace.getConfiguration("pi-on-code");
      const sessionDir = cfg.get<string>("sessionDir")?.trim() || undefined;
      if (openPath) {
        this.sessionManager = SDK.SessionManager.open(openPath, sessionDir);
      } else if (fresh) {
        this.sessionManager = SDK.SessionManager.create(cwd, sessionDir);
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
    let resumeThinkingLevel = cfg.get<string>("defaultThinkingLevel") ?? "off";
    let foundSessionModel = false;
    let foundSessionThinking = false;
    const isResuming = !fresh && this.sessionManager;
    if (isResuming) {
      const entries = this.sessionManager.getEntries?.();
      if (Array.isArray(entries)) {
        piLog(`Restoring model/thinking from session: ${entries.length} entries`);
        // Walk entries in reverse to find the last model_change and thinking_level_change
        for (let i = entries.length - 1; i >= 0; i--) {
          const e = entries[i];
          if (!foundSessionModel && e.type === "model_change" && e.provider && e.modelId) {
            // Try to resolve the model from the registry
            const found = this.modelRegistry.find(e.provider, e.modelId);
            if (found) {
              resumeModel = found;
              foundSessionModel = true;
              piLog(`Restored model from session: ${e.provider}/${e.modelId}`);
            } else {
              // Fallback: resolve through the canonical model runtime.
              const m = getRuntimeModel(this.modelRuntime, e.provider, e.modelId);
              if (m) {
                resumeModel = m;
                foundSessionModel = true;
                piLog(`Restored model from session (fallback): ${e.provider}/${e.modelId}`);
              } else {
                piWarn(`Could not resolve session model: ${e.provider}/${e.modelId}`);
              }
            }
          }
          if (!foundSessionThinking && e.type === "thinking_level_change" && e.thinkingLevel) {
            resumeThinkingLevel = e.thinkingLevel;
            foundSessionThinking = true;
            piLog(`Restored thinking from session: ${e.thinkingLevel}`);
          }
          // Stop early once both are resolved
          if (foundSessionModel && foundSessionThinking) { break; }
        }
        if (!foundSessionModel) { piLog("No model_change entry found in session"); }
        if (!foundSessionThinking) { piLog("No thinking_level_change entry found in session"); }
      }
    } else {
      piLog(`Skipping session restore (fresh=${fresh}, hasSessionManager=${!!this.sessionManager})`);
    }

    // ── Step 9: Create agent session ───────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any;
    try {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opts: any = {
        services,
        model: resumeModel,
        thinkingLevel: resumeThinkingLevel,
        sessionManager: this.sessionManager,
        customTools: tools,
      };

      // Scoped models from registry (dynamic)
      if (this.cycleModels.length > 0) {
        opts.scopedModels = buildScopedModels(this.modelRuntime, this.cycleModels);
      }

      // Inject before extensions load (SDK may load them during createAgentSession)
      (globalThis as Record<string, unknown>).__piRegisterMessageRenderer = (customType: string, sourceCode: string) => {
        this.emit({ type: "registerMessageRenderer", data: { customType, sourceCode } });
      };

      result = await SDK.createAgentSessionFromServices(opts);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return { success: false, error: `createAgentSessionFromServices failed: ${e.message ?? e}` };
    }

    this.session = result.session;
    this._thinkingLevel = resumeThinkingLevel;
    this.sessionId = this.session.sessionId;

    // Restore active tools from session file (if resuming)
    if (isResuming) {
      this._restoreActiveToolsFromSession();
    }

    // Update cached model if resume overrode it
    if (resumeModel !== model) {
      this._model = { id: resumeModel.id, name: resumeModel.name, provider: resumeModel.provider };
    }

    // ── Step 10: Subscribe to events ───────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.unsubscribe = this.session.subscribe((event: any) => {
      this.handleAgentEvent(event);
    });

    // ── Step 11: Bind extensions with webview-bridged UIContext ─
    await this.bindExtensionUI();

    // ── Step 12: Send initial message history (like TUI renderInitialMessages) ──
    await this.emitInitialHistoryReplay();

    this.reportStatus();
    try {
      this.emitScopedModels();
      this.emitSettings();
      this.emitSlashCommands();
    } catch (e: unknown) {
      piWarn(`Post-init emissions failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    return { success: true };
  }

  // ── Extension UI Bridge ────────────────────────────

  /**
   * Bind extensions with a UIContext that bridges to the VS Code webview.
   * Without this, extensions like pi-tldr have hasUI=false and their
   * notify/setWidget calls silently do nothing.
   */
  private async bindExtensionUI(): Promise<void> {
    if (!this.session || typeof this.session.bindExtensions !== "function") {
      return;
    }

    const emit = (event: PiServiceEvent): void => this.emit(event);

    // Active widgets keyed by widget key (rendered text per widget)
    const widgetTexts = new Map<string, string>();
    const widgetLastUpdate = new Map<string, number>();
    // Periodically check for stale widgets (not updated in 30s) and clear them.
    // This prevents orphaned animations from running forever when extensions
    // forget to call stopWidgetAnimation (e.g. pi-subagents async jobs).
    const MAX_WIDGET_IDLE_MS = 30_000;
    this._widgetTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, lastUpdate] of widgetLastUpdate) {
        if (now - lastUpdate > MAX_WIDGET_IDLE_MS) {
          widgetTexts.delete(key);
          widgetLastUpdate.delete(key);
          emit({ type: "widget-update", data: { key, content: null } });
        }
      }
    }, 10_000);
    if (this._widgetTimer.unref) { this._widgetTimer.unref(); }

    // Base uiContext with the methods we explicitly support.
    // Wrapped in a Proxy so any unknown method calls (e.g. from TUI-only
    // extensions) silently no-op instead of throwing "is not a function".
    const baseUIContext = {
      // Extensions may format status text through ui.theme before calling
      // setStatus(). Keep the text unchanged because the Webview owns colors.
      theme: {
        fg: (_role: string, text: string) => text,
      },
      notify: (message: string, level: "info" | "error") => {
        if (level === "error") {
          piWarn(`ui.notify(error): ${message.substring(0, 120)}`);
        }
        emit({
          type: "custom-message",
          data: {
            customType: level === "error" ? "error" : "extension-notify",
            content: message,
            timestamp: Date.now(),
          },
        });
      },
      setWidget: (key: string, factory: unknown) => {
        if (factory === undefined || factory === null) {
          // Clear widget
          widgetTexts.delete(key);
          widgetLastUpdate.delete(key);
          emit({
            type: "widget-update",
            data: { key, content: null },
          });
          return;
        }

        if (typeof factory !== "function") {
          piWarn(`setWidget("${key}"): factory is not a function (got ${typeof factory})`);
          return;
        }

        try {
          // Minimal Theme stub: fg returns text without ANSI codes.
          // Widgets render in an HTML webview so ANSI colors are unnecessary.
          const theme = {
            fg: (_role: string, text: string) => text,
          };
          // Minimal TUI stub — extensions that need tui methods won't work,
          // but pi-tldr and similar widgets only use theme.
          const tui = {};

          const component = (factory)(tui, theme) as {
            render?: (width: number) => string[];
          };
          if (!component || typeof component.render !== "function") {
            piWarn(`setWidget("${key}"): component.render is not a function`);
            return;
          }

          const lines = component.render(80);
          if (!Array.isArray(lines)) {
            piWarn(`setWidget("${key}"): render() did not return an array`);
            return;
          }

          // Strip any remaining ANSI escape codes (just in case)
          const ansiRegex = /\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[_][^\x07\x1b]*(?:\x07|\x1b\\)/g;
          const cleanLines = lines.map((l: string) => l.replace(ansiRegex, ""));
          const content = cleanLines.join("\n");

          // Skip if unchanged
          if (widgetTexts.get(key) === content) { return; }
          widgetTexts.set(key, content);
          widgetLastUpdate.set(key, Date.now());

          emit({
            type: "widget-update",
            data: { key, content },
          });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          // Widget rendering is best-effort; don't crash the session.
          piWarn(`setWidget("${key}"): render error: ${e?.message ?? e}`);
        }
      },
      // Interactive methods — return Promises that resolve when the user
      // dismisses the dialog in the webview.  Falls back to undefined if
      // no webview panel is active (e.g. during tests).
      select: (prompt: string, options: string[]) => {
        return this._showDialog("select", prompt, { options });
      },
      confirm: (prompt: string) => {
        return this._showDialog("confirm", prompt, {});
      },
      input: (prompt: string, defaultValue?: string) => {
        return this._showDialog("input", prompt, { defaultValue });
      },
      // Run focused TUI components in the extension host and send their
      // rendered text frames to the Webview. Keyboard input travels back to
      // the component through handleInput().
      custom: (factory: RemoteCustomUiFactory, options?: RemoteCustomUiOptions) => {
        return this._showCustomUi(factory, options);
      },

      // TUI compatibility stubs discovered via the Proxy at runtime
      setToolsExpanded: (_expanded: boolean) => { /* stub — TUI widget expand/collapse */ },
      getToolsExpanded: () => false,
      requestRender: () => { /* stub — TUI repaint, not needed in webview */ },
      onTerminalInput: (_handler: unknown) => { /* stub */ },
      setStatus: (key: string, status: string | null) => {
        // Show as a widget card so status is visible in VS Code
        if (status === null || status === undefined) {
          widgetTexts.delete(`status-${key}`);
          emit({ type: "widget-update", data: { key: `status-${key}`, content: null } });
        } else {
          const content = `**${key}** ${status}`;
          widgetTexts.set(`status-${key}`, content);
          emit({ type: "widget-update", data: { key: `status-${key}`, content } });
        }
      },
    };

    // Proxy: log unknown method calls so we can see what TUI methods
    // extensions expect, then no-op gracefully instead of crashing.
    const uiContext = new Proxy(baseUIContext, {
      get(target, prop) {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (prop in target) { return (target as any)[prop]; }
        if (typeof prop === "string" && !prop.startsWith("_")) {
          return (...args: unknown[]) => {
            piWarn(`ui.${prop}() called by extension but not implemented — args: ${JSON.stringify(args).substring(0, 200)}`);
          };
        }
        return undefined;
      },
    });

    try {
      await this.session.bindExtensions({
        uiContext,
        // Pi on Code provides RPC-style dialogs in a Webview, not a terminal
        // component host. Extensions such as rpiv-ask-user-question use this
        // mode to select their select()/input() fallback instead of ui.custom().
        mode: "rpc",
        onError: (error: Error, extensionPath: string) => {
          piWarn(`Extension error [${extensionPath}]: ${error?.message ?? error}`);
        },
      });
      piLog("Extension UI context bound");
      const extensions = this.getLoadedExtensions();
      piLog(`Loaded extensions: ${extensions.length > 0 ? extensions.map((extension) => extension.path).join(", ") : "none"}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      piWarn(`bindExtensions failed: ${e.message ?? e}`);
    }

    // Push updated capability and slash-command lists after registration.
    this.emitCapabilities();
    this.emitSlashCommands();
  }

  /** Return extensions loaded in this session, not merely installed packages. */
  getLoadedExtensions(): LoadedExtension[] {
    try {
      const runner = this.session?.extensionRunner ?? this.session?._extensionRunner;
      const paths: unknown = runner?.getExtensionPaths?.();
      if (!Array.isArray(paths)) { return []; }

      const seen = new Set<string>();
      const extensions: LoadedExtension[] = [];
      for (const value of paths) {
        if (typeof value !== "string" || seen.has(value)) { continue; }
        seen.add(value);
        extensions.push({ name: extensionDisplayName(value), path: value });
      }
      return extensions;
    } catch (error: unknown) {
      piWarn(`Could not inspect loaded extensions: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  getLoadedSkills(): LoadedSkill[] {
    try {
      const rawSkills: unknown = this.resourceLoader?.getSkills?.()?.skills;
      if (!Array.isArray(rawSkills)) { return []; }
      return rawSkills.flatMap((value): LoadedSkill[] => {
        if (!value || typeof value !== "object") { return []; }
        const skill = value as Record<string, unknown>;
        if (typeof skill.name !== "string" || typeof skill.filePath !== "string") { return []; }
        const sourceInfo = skill.sourceInfo && typeof skill.sourceInfo === "object"
          ? skill.sourceInfo as Record<string, unknown>
          : undefined;
        const scope = sourceInfo?.scope;
        return [{
          name: skill.name,
          description: typeof skill.description === "string" ? skill.description : "",
          path: skill.filePath,
          scope: scope === "user" || scope === "project" || scope === "temporary"
            ? scope
            : undefined,
        }];
      });
    } catch (error: unknown) {
      piWarn(`Could not inspect loaded skills: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  /** Notify the Webview about capabilities active in the current Pi session. */
  emitCapabilities(): void {
    this.emit({
      type: "capabilities-update",
      data: {
        extensions: this.getLoadedExtensions(),
        skills: this.getLoadedSkills(),
      },
    });
  }

  /** Mirror Pi RPC get_commands: extensions, prompt templates, and skills. */
  getAllSlashCommands(): SlashCommandInfo[] {
    const result: SlashCommandInfo[] = [];
    const readScope = (value: unknown): SlashCommandInfo["scope"] => {
      if (!value || typeof value !== "object") { return undefined; }
      const scope = (value as Record<string, unknown>).scope;
      return scope === "user" || scope === "project" || scope === "temporary"
        ? scope
        : undefined;
    };

    try {
      const runner = this.session?.extensionRunner ?? this.session?._extensionRunner;
      const commands: unknown = runner?.getRegisteredCommands?.();
      if (Array.isArray(commands)) {
        for (const value of commands) {
          if (!value || typeof value !== "object") { continue; }
          const command = value as Record<string, unknown>;
          if (typeof command.invocationName !== "string") { continue; }
          result.push({
            cmd: `/${command.invocationName}`,
            desc: typeof command.description === "string" ? command.description : "",
            source: "extension",
            scope: readScope(command.sourceInfo),
          });
        }
      }
    } catch (error: unknown) {
      piWarn(`Could not inspect extension commands: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const prompts: unknown = this.resourceLoader?.getPrompts?.()?.prompts;
      if (Array.isArray(prompts)) {
        for (const value of prompts) {
          if (!value || typeof value !== "object") { continue; }
          const prompt = value as Record<string, unknown>;
          if (typeof prompt.name !== "string") { continue; }
          result.push({
            cmd: `/${prompt.name}`,
            desc: typeof prompt.description === "string" ? prompt.description : "",
            source: "prompt",
            scope: readScope(prompt.sourceInfo),
          });
        }
      }
    } catch (error: unknown) {
      piWarn(`Could not inspect prompt templates: ${error instanceof Error ? error.message : String(error)}`);
    }

    for (const skill of this.getLoadedSkills()) {
      result.push({
        cmd: `/skill:${skill.name}`,
        desc: skill.description,
        source: "skill",
        scope: skill.scope,
      });
    }

    result.push(
      { cmd: "/model", desc: "Switch model", source: "builtin" },
      { cmd: "/new", desc: "Start new session", source: "builtin" },
      { cmd: "/resume", desc: "Resume a previous session", source: "builtin" },
      { cmd: "/fork", desc: "Fork session from message", source: "builtin" },
      { cmd: "/compact", desc: "Compact context", source: "builtin" },
      { cmd: "/export", desc: "Export session to HTML", source: "builtin" },
      { cmd: "/settings", desc: "Open settings", source: "builtin" },
      { cmd: "/login", desc: "Configure provider authentication", source: "builtin" },
      { cmd: "/logout", desc: "Remove provider authentication", source: "builtin" },
      { cmd: "/debug", desc: "Dump webview state for troubleshooting", source: "builtin" },
      { cmd: "/reload", desc: "Reload extensions, skills, and context", source: "builtin" },
      { cmd: "/tools", desc: "Select which tools are active", source: "builtin" },
    );

    const builtinNames = new Set(
      result.filter((command) => command.source === "builtin").map((command) => command.cmd),
    );
    const seen = new Set<string>();
    return result.filter((command) => {
      if (command.source !== "builtin" && builtinNames.has(command.cmd)) { return false; }
      if (seen.has(command.cmd)) { return false; }
      seen.add(command.cmd);
      return true;
    });
  }

  /** Emit all registered slash commands to the webview for autocomplete. */
  emitSlashCommands(): void {
    const all = this.getAllSlashCommands();
    this.emit({
      type: "slash-commands-update",
      data: { commands: all },
    });
  }

  /** Send a lightweight minimap index for the complete Session history. */
  private emitConversationTurns(entries?: readonly unknown[]): void {
    try {
      const source = entries ?? this.sessionManager?.getEntries?.() ?? [];
      this.emit({
        type: "conversation-turns-update",
        data: { turns: buildConversationTurnPreviews(source) },
      });
    } catch (error: unknown) {
      piWarn(`Could not build conversation minimap: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Return a snapshot that a newly-ready Webview can replay without races. */
  getInitialHistoryReplayEvents(): PiServiceEvent[] {
    return this.initialHistoryReplayEvents.slice();
  }

  private async emitInitialHistoryReplay(): Promise<void> {
    const entries = this.sessionManager?.getEntries?.() ?? [];
    const hasEntries = entries.some(isVisibleHistoryEntry);
    this.initialHistoryReplayEvents = [];
    this.capturingInitialHistoryReplay = true;
    let hasMoreHistory = false;
    try {
      this.emit({ type: "batch-start", data: { hasEntries } });
      hasMoreHistory = await this.sendInitialMessages();
    } finally {
      this.emit({ type: "batch-end", data: { hasEntries, hasMoreHistory } });
      this.capturingInitialHistoryReplay = false;
    }
  }

  /** Send only the newest history page to the Webview on initial load. */
  async sendInitialMessages(): Promise<boolean> {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    let entries: any[];
    try {
      entries = this.sessionManager.getEntries();
      piLog(`sendInitialMessages: ${entries?.length ?? 0} entries`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      piWarn(`sendInitialMessages: getEntries failed: ${e.message}`);
      return false;
    }

    this.historyEntries = entries ?? [];
    this.historyToolResultsById = new Map();
    for (const entry of this.historyEntries) {
      if (entry.type === "message" && entry.message?.role === "toolResult") {
        this.historyToolResultsById.set(entry.message.toolCallId, entry);
      }
    }
    this.cacheUserMessageHistory(this.historyEntries);
    this.emitConversationTurns(this.historyEntries);

    if (this.historyEntries.length === 0) {
      this.historyCursor = 0;
      return false;
    }

    this.historyCursor = findHistoryPageStart(this.historyEntries, this.historyEntries.length);
    await this.replayHistoryEntries(
      this.historyEntries.slice(this.historyCursor),
      this.historyToolResultsById,
      true,
    );
    return this.historyCursor > 0;
  }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
  private cacheUserMessageHistory(entries: any[]): void {
    this._userMessages = [];
    for (const entry of entries) {
      const message = entry.type === "message" ? entry.message : undefined;
      if (message?.role !== "user") { continue; }
      const prompt = splitEditorContext(this.extractTextFromContent(message.content));
      if (!prompt.text) { continue; }
      this._userMessages.push({
        id: message.id ?? `user-${this._userMessages.length}`,
        text: prompt.text,
        timestamp: message.timestamp,
      });
      if (this._userMessages.length > 50) { this._userMessages.shift(); }
    }
  }

  private async replayHistoryEntries(
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    entries: any[],
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolResultsById: Map<string, any>,
    yieldBetweenEntries: boolean,
  ): Promise<void> {
    const yieldTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.type === "message" && entry.message) {
        const msg = entry.message;
        if (msg.role === "user") {
          const prompt = splitEditorContext(this.extractTextFromContent(msg.content));
          const images = this.extractImagesFromContent(msg.content);
          if (prompt.text || images.length > 0 || prompt.context?.items.length) {
            this.emit({
              type: "chat-message",
              data: {
                role: "user",
                content: prompt.text,
                images,
                editorContext: prompt.context?.items,
                entryId: entry.id,
              },
            });
          }
        } else if (msg.role === "assistant") {
          const text = this.extractTextFromContent(msg.content);
          const thinking = this.extractThinkingFromContent(msg.content);
          const toolCalls = this.extractToolCallsFromContent(msg.content);
          

          // Always emit assistant messages — even tool-only ones with no text.
          // Skipping them makes tool executions invisible on reload/resume.
          this.emit({ type: "assistant-start", data: { messageId: msg.id, entryId: entry.id } });
          // Emit thinking content first, then text
          if (thinking) {
            this.emit({ type: "thinking-delta", data: { delta: thinking } });
            this.emit({ type: "thinking-delta", data: { delta: "", done: true } });
          }
          if (text) {
            this.emit({ type: "stream-delta", data: { delta: text } });
          }
          this.emit({
            type: "assistant-end",
            data: {
              stopReason: msg.stopReason,
              errorMessage: msg.errorMessage,
              toolCalls: toolCalls.map((tc) => tc.id),
            },
          });

          for (const tc of toolCalls) {
            const toolResultEntry = toolResultsById.get(tc.id);
            if (tc.name === "bash" || tc.name === "exec") {
              this.emit({ type: "bash-start", data: { toolCallId: tc.id, command: tc.arguments?.command ?? "", entryId: toolResultEntry?.id } });
              const outputText = toolResultEntry?.message
                ? this.extractTextFromContent(toolResultEntry.message.content)
                : "";
              this.emit({
                type: "bash-end",
                data: { toolCallId: tc.id, command: tc.arguments?.command ?? "", exitCode: 0, cancelled: false, output: outputText, isError: false, entryId: toolResultEntry?.id },
              });
            } else {
              this.emit({ type: "tool-start", data: { toolCallId: tc.id, toolName: tc.name, args: tc.arguments, fromMessage: true, entryId: toolResultEntry?.id } });
              if (toolResultEntry?.message) {
                this.emit({ type: "tool-end", data: { toolCallId: tc.id, toolName: tc.name, result: toolResultEntry.message, isError: false, entryId: toolResultEntry?.id } });
              } else {
                this.emit({ type: "tool-end", data: { toolCallId: tc.id, toolName: tc.name, result: { content: [{ type: "text", text: "(completed)" }] }, isError: false, entryId: toolResultEntry?.id } });
              }
            }
          }
        } else if (msg.role === "custom") {
          this.emit({ type: "custom-message", data: { customType: msg.customType, content: msg.content, display: msg.display, details: msg.details, timestamp: msg.timestamp, entryId: entry.id } });
        } else if (msg.role === "bashExecution") {
          const bashEntryId = entry.id ?? `bash-${Date.now()}`;
          this.emit({ type: "bash-start", data: { toolCallId: bashEntryId, command: msg.command ?? "", entryId: entry.id } });
          this.emit({ type: "bash-end", data: { toolCallId: bashEntryId, command: msg.command ?? "", exitCode: msg.exitCode, cancelled: msg.cancelled, output: msg.output ?? "", isError: msg.exitCode !== 0 && msg.exitCode !== null, entryId: entry.id } });
        }
      } else if (entry.type === "compaction") {
        this.emit({
          type: "compaction-summary-message",
          data: { summary: entry.summary ?? "", tokensBefore: entry.tokensBefore ?? 0, timestamp: this._toTimestamp(entry.timestamp), entryId: entry.id },
        });
      }

      if (yieldBetweenEntries && isVisibleHistoryEntry(entry)) { await yieldTick(); }
    }
  }

  /** Replay the next older history page above the current Webview content. */
  async loadOlderHistory(): Promise<void> {
    if (this.historyPageLoading) { return; }
    if (this.historyCursor <= 0) {
      this.emit({
        type: "history-page",
        data: { hasMoreHistory: false, events: [] },
      });
      return;
    }
    this.historyPageLoading = true;

    const end = this.historyCursor;
    const start = findHistoryPageStart(this.historyEntries, end);
    const events: PiServiceEvent[] = [];
    let replayPromise: Promise<void>;
    try {
      this.historyReplayCollector = events;
      replayPromise = this.replayHistoryEntries(
        this.historyEntries.slice(start, end),
        this.historyToolResultsById,
        false,
      );
    } finally {
      // replayHistoryEntries runs synchronously when yielding is disabled.
      // Stop collecting before awaiting so live events remain live.
      this.historyReplayCollector = null;
    }

    let delivered = false;
    try {
      await replayPromise;
      this.historyCursor = start;
      this.emit({
        type: "history-page",
        data: { hasMoreHistory: this.historyCursor > 0, events },
      });
      delivered = true;
    } finally {
      this.historyPageLoading = false;
      if (!delivered) {
        this.emit({
          type: "history-page",
          data: { hasMoreHistory: this.historyCursor > 0, events: [] },
        });
      }
    }
  }

  /** Load enough older pages to reveal a minimap turn that is not in the DOM. */
  async loadHistoryToEntry(entryId: string): Promise<void> {
    const targetIndex = this.historyEntries.findIndex((entry) => entry?.id === entryId);
    if (targetIndex < 0) {
      piWarn(`Could not locate minimap history entry: ${entryId}`);
      return;
    }

    while (this.historyCursor > targetIndex) {
      if (this.historyPageLoading) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        continue;
      }
      const previousCursor = this.historyCursor;
      await this.loadOlderHistory();
      if (this.historyCursor >= previousCursor) { break; }
    }
    this.emit({ type: "revealEntry", entryId });
  }

  // ── Agent event → PiServiceEvent translation ────────────

  /** SDK entries store timestamps as ISO strings; protocol expects numbers. */
  private _toTimestamp(ts: unknown): number {
    if (typeof ts === "number") { return ts; }
    if (ts) { return Date.parse(String(ts)); }
    return Date.now();
  }

  /** Extract plain text from a message content (string or array) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractTextFromContent(content: any): string {
    if (!content) { return ""; }
    if (typeof content === "string") { return content; }
    if (Array.isArray(content)) {
      return content
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((c: any) => c.type === "text")
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((c: any) => c.text)
        .join("\n");
    }
    return "";
  }

  /** Extract image blocks from a user message content array. */
  private extractImagesFromContent(content: unknown): ImageContent[] {
    if (!Array.isArray(content)) { return []; }

    const images: ImageContent[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") { continue; }
      const candidate = item as Record<string, unknown>;
      if (
        candidate.type === "image" &&
        typeof candidate.data === "string" &&
        candidate.data.length > 0 &&
        typeof candidate.mimeType === "string" &&
        candidate.mimeType.startsWith("image/")
      ) {
        images.push({ type: "image", data: candidate.data, mimeType: candidate.mimeType });
      }
    }
    return images;
  }

  /** Extract thinking content blocks from an assistant message content array */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractThinkingFromContent(content: any): string {
    if (!content) { return ""; }
    if (Array.isArray(content)) {
      return content
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((c: any) => c.type === "thinking")
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((c: any) => c.thinking)
        .join("\n");
    }
    return "";
  }

  /** Extract tool call content blocks from an assistant message */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractToolCallsFromContent(content: any[]): Array<{ name: string; id: string; arguments: any }> {
    if (!content) { return []; }
    return content
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((c: any) => c.type === "toolCall")
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((c: any) => ({ name: c.name, id: c.id, arguments: c.arguments }));
  }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
  private assistantEndData(message: any): {
    stopReason?: string;
    errorMessage?: string;
    toolCalls: string[];
  } {
    const toolCalls = this.extractToolCallsFromContent(message?.content);
    const hasVisibleContent = this.extractTextFromContent(message?.content).trim().length > 0
      || this.extractThinkingFromContent(message?.content).trim().length > 0
      || toolCalls.length > 0;
    const stopReason = message?.stopReason;

    if (!hasVisibleContent && stopReason !== "error" && stopReason !== "aborted") {
      return {
        stopReason: "error",
        errorMessage: "The model returned an empty response. Try enabling thinking/reasoning or selecting another model.",
        toolCalls: [],
      };
    }

    return {
      stopReason,
      errorMessage: message?.errorMessage,
      toolCalls: toolCalls.map((toolCall) => toolCall.id),
    };
  }

  /** Get entries once per event, plus pre-built lookups to avoid O(n²) scans. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getEntriesWithLookups(): { entries: any[]; byMessageId: Map<string, any>; byToolCallId: Map<string, any> } {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries: any[] = this.sessionManager?.getEntries?.() ?? [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byMessageId = new Map<string, any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byToolCallId = new Map<string, any>();
    for (const e of entries) {
      if (e.type === "message") {
        if (e.message?.id) { byMessageId.set(e.message.id, e); }
        if (e.message?.role === "toolResult" && e.message?.toolCallId) {
          byToolCallId.set(e.message.toolCallId, e);
        }
      }
    }
    return { entries, byMessageId, byToolCallId };
  }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleAgentEvent(event: any): void {
    switch (event.type) {
      case "agent_start":
        this._isStreaming = true;
        this.currentAssistantToolCalls.clear();
        this.turnIndex = 0;
        this.emit({ type: "agent-start" });
        break;

      case "agent_end":
        this._isStreaming = false;
        this.currentAssistantToolCalls.clear();
        this.turnIndex = 0;
        this.emit({ type: "agent-end", data: { messages: event.messages } });
        this.emitConversationTurns();
        this.reportStatus();
        break;

      // SDK 0.80 emits this after retries and queued follow-ups have finished.
      // agent_end already closes the rendered response; settled only confirms
      // the session is fully idle, so do not emit a duplicate agent-end.
      case "agent_settled":
        this._isStreaming = false;
        this.currentAssistantToolCalls.clear();
        this.turnIndex = 0;
        this.reportStatus();
        break;

      case "turn_start":
        this.emit({ type: "turn-start" });
        break;

      case "turn_end":
        this.emit({ type: "turn-end", data: { message: event.message, toolResults: event.toolResults } });
        this.turnIndex++;
        break;

      case "message_start": {
        const { entries, byMessageId } = this.getEntriesWithLookups();
        if (event.message?.role === "user") {
          const prompt = splitEditorContext(this.extractTextFromContent(event.message.content));
          const images = this.extractImagesFromContent(event.message.content);
          if (prompt.text || images.length > 0 || prompt.context?.items.length) {
            if (prompt.text) {
              this._userMessages.push({ id: event.message.id ?? `user-${Date.now()}`, text: prompt.text, timestamp: event.message.timestamp ?? Date.now() });
              if (this._userMessages.length > 50) { this._userMessages.shift(); }
            }
            const entry = byMessageId.get(event.message.id);
            this.emit({
              type: "chat-message",
              data: {
                role: "user",
                content: prompt.text,
                images,
                editorContext: prompt.context?.items,
                entryId: entry?.id ?? event.message.id,
              },
            });
          }
          this.emitConversationTurns(entries);
        } else if (event.message?.role === "assistant") {
          this.currentAssistantToolCalls.clear();
          const entry = byMessageId.get(event.message.id);
          this.emit({ type: "assistant-start", data: { messageId: event.message.id, entryId: entry?.id ?? event.message.id } });
        }
        break;
      }

      case "message_update": {
        const d = event.assistantMessageEvent;
        switch (d?.type) {
          case "text_delta":
            this.emit({ type: "stream-delta", data: { delta: d.delta } });
            break;
          case "thinking_delta":
            this.emit({ type: "thinking-delta", data: { delta: d.delta } });
            break;
          case "thinking_end":
            this.emit({ type: "thinking-delta", data: { delta: "", done: true } });
            break;
          case "error":
            this.emit({ type: "error", data: { message: d.error ?? "Unknown error" } });
            break;
        }

        if (event.message?.role === "assistant" && event.message?.content) {
          const toolCalls = this.extractToolCallsFromContent(event.message.content);
          for (const tc of toolCalls) {
            // Skip bash/exec tools — they have their own rendering path
            // (bash-start/bash-output/bash-end) and don't need generic
            // tool-start/tool-update events that would leak JSON args into
            // the bash output div as {}{}{}{} artifacts.
            if (tc.name === "bash" || tc.name === "exec") { continue; }
            if (!this.currentAssistantToolCalls.has(tc.id)) {
              this.currentAssistantToolCalls.set(tc.id, { toolName: tc.name, toolCallId: tc.id, args: tc.arguments });
              this.emit({ type: "tool-start", data: { toolCallId: tc.id, toolName: tc.name, args: tc.arguments, fromMessage: true } });
            } else {
              const existing = this.currentAssistantToolCalls.get(tc.id);
              if (existing) {
                existing.args = tc.arguments;
                this.emit({ type: "tool-update", data: { toolCallId: tc.id, toolName: tc.name, partialResult: { content: [{ type: "text", text: JSON.stringify(tc.arguments, null, 2) }] } } });
              }
            }
          }
        }
        break;
      }

      case "message_end":
        if (event.message?.role === "user") { break; }
        if (event.message?.role === "assistant") {
          const data = this.assistantEndData(event.message);
          if (data.stopReason === "error" && event.message.stopReason !== "error") {
            const model = this._model?.id ?? this._model?.name ?? "unknown model";
            piWarn(`Empty assistant response from ${model} (thinking: ${this._thinkingLevel}, original stop reason: ${event.message.stopReason ?? "missing"})`);
          }
          this.emit({ type: "assistant-end", data });
          this.reportStatus();
        } else if (event.message?.role === "custom") {
          const { entries } = this.getEntriesWithLookups();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
          const custEntry = reverseFind(entries, (e: any) => e.type === "message" && e.message?.role === "custom");
          this.emit({ type: "custom-message", data: { customType: event.message.customType, content: event.message.content, display: event.message.display, details: event.message.details, timestamp: event.message.timestamp, entryId: custEntry?.id ?? event.message.id } });
        }
        break;

      case "tool_execution_start": {
        const { byToolCallId } = this.getEntriesWithLookups();
        const tcEntry = byToolCallId.get(event.toolCallId);
        const tcEntryId = tcEntry?.id ?? event.toolCallId;

        // Apply the tool's prepareArguments hook so the webview receives
        // validated/transformed args (e.g. legacy oldText/newText → edits[]
        // for the edit tool).  The SDK runs prepareArguments internally but
        // only after emitting this event, so raw LLM args leak through.
        let args = event.args;
        try {
          const tools = this.session?.agent?.state?.tools;
          if (tools) {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
            const toolDef = (tools as any[]).find((t: any) => t.name === event.toolName);
            if (toolDef?.prepareArguments) {
              args = toolDef.prepareArguments(args);
            }
          }
        } catch (_e: unknown) { piWarn(`Tool param decode skipped: ${_e instanceof Error ? _e.message : String(_e)}`); }

        if (event.toolName === "write" && typeof args?.path === "string" && typeof args?.content === "string") {
          const filePath = path.isAbsolute(args.path) ? args.path : path.resolve(getWorkspaceCwd(), args.path);
          let before = "";
          try {
            before = fs.readFileSync(filePath, "utf8");
          } catch {
            // A failed snapshot must not interfere with the write itself. The
            // successful result will use an empty baseline in this rare case.
          }
          this.writeChanges.set(event.toolCallId, { before, after: args.content });
        }

        if (event.toolName === "bash" || event.toolName === "exec") {
          this.emit({ type: "bash-start", data: { toolCallId: event.toolCallId, command: args?.command ?? "", entryId: tcEntryId } });
        } else {
          this.emit({ type: "tool-start", data: { toolCallId: event.toolCallId, toolName: event.toolName, args: args, fromMessage: false, entryId: tcEntryId } });
        }
        break;
      }

      case "tool_execution_update":
        if (event.toolName === "bash" || event.toolName === "exec") {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
          const text = event.partialResult?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
          this.emit({ type: "bash-output", data: { toolCallId: event.toolCallId, output: text ?? "" } });
        } else {
          this.emit({ type: "tool-update", data: { toolCallId: event.toolCallId, toolName: event.toolName, partialResult: event.partialResult } });
        }
        break;

      case "tool_execution_end": {
        const { byToolCallId } = this.getEntriesWithLookups();
        const tcEntry = byToolCallId.get(event.toolCallId);
        const tcEntryId = tcEntry?.id ?? event.toolCallId;

        if (event.toolName === "bash" || event.toolName === "exec") {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
          const text = event.result?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
          this.emit({ type: "bash-end", data: { toolCallId: event.toolCallId, command: event.args?.command ?? "", exitCode: event.isError ? 1 : 0, cancelled: false, output: text ?? "", isError: event.isError, entryId: tcEntryId } });
        } else {
          let result = event.result;
          const writeChange = this.writeChanges.get(event.toolCallId);
          this.writeChanges.delete(event.toolCallId);
          if (event.toolName === "write" && !event.isError && writeChange) {
            result = {
              ...event.result,
              details: {
                ...(event.result?.details ?? {}),
                changeSummary: formatLineChangeSummary(writeChange.before, writeChange.after),
              },
            };
          }
          this.emit({ type: "tool-end", data: { toolCallId: event.toolCallId, toolName: event.toolName, result, isError: event.isError, entryId: tcEntryId } });
        }
        break;
      }

      case "session_info_changed":
        this.reportStatus();
        break;

      case "thinking_level_changed":
        this._thinkingLevel = event.level;
        this.emit({ type: "thinking-level-changed", data: { level: event.level } });
        this.reportStatus();
        break;

      case "queue_update":
        piLog(`queue_update: steering=${event.steering?.length ?? 0}, followUp=${event.followUp?.length ?? 0}`);
        this.emit({ type: "queue-update", data: { steering: Array.from(event.steering ?? []), followUp: Array.from(event.followUp ?? []) } });
        break;

      case "compaction_start":
        this.emit({ type: "compaction-start", data: { reason: event.reason } });
        break;

      case "compaction_end":
        this.emit({ type: "compaction-end", data: { reason: event.reason, aborted: event.aborted, willRetry: event.willRetry, result: event.result, errorMessage: event.errorMessage } });
        if (event.result) {
          const { entries } = this.getEntriesWithLookups();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
          const compactEntry = reverseFind(entries, (e: any) => e.type === "compaction");
          this.emit({ type: "compaction-summary-message", data: { summary: event.result.summary, tokensBefore: event.result.tokensBefore, timestamp: Date.now(), entryId: compactEntry?.id } });
        }
        break;

      case "auto_retry_start":
        this.emit({ type: "auto-retry-start", data: { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, errorMessage: event.errorMessage } });
        break;

      case "auto_retry_end":
        this.emit({ type: "auto-retry-end", data: { success: event.success, attempt: event.attempt, finalError: event.finalError } });
        break;

      default:
        // Surface unknown SDK events as visible notifications so they
        // aren't silently lost.  Add a case above once handled.
        this.emit({
          type: "custom-message",
          data: {
            customType: "pi-on-code-diagnostic",
            display: false,
            content: `Unhandled agent event: ${event.type}`,
            timestamp: Date.now(),
          },
        });
        piWarn(`Unhandled agent event type: ${event.type}`);
        break;
    }
  }

  private reportStatus(): void {
    const stats = this.getUsageStats();
    const cfg = vscode.workspace.getConfiguration("pi-on-code");
    const budget = cfg.get<number>("contextBudget") ?? 0;
    this.emit({
      type: "status-update",
      data: {
        model: this._model?.id ?? this._model?.name ?? "pi",
        thinkingLevel: this._thinkingLevel,
        effort: this._effort,
        isStreaming: this._isStreaming,
        sessionId: this.sessionId ?? undefined,
        usage: stats,
        contextBudget: budget,
      },
    });
  }

  // ── User actions ───────────────────────────────────────

  async sendPrompt(text: string, images?: ImageContent[], mode?: string): Promise<void> {
    if (!this.session) { throw new Error("Pi session not initialized"); }

    for (const image of images ?? []) {
      if (image.type !== "image" || !image.mimeType?.startsWith("image/") || !image.data) {
        throw new Error("Cannot send image: attachment data or MIME type is invalid");
      }
    }

    // Handle slash commands at the PiService level before forwarding to
    // session.prompt(). Builtin commands (from the SDK's BUILTIN_SLASH_COMMANDS
    // list) map to PiService methods.
    //
    // IMPORTANT: unhandled slash commands (extension commands like /tldr,
    // and unknown commands) MUST go through session.prompt() even during
    // streaming.  The SDK executes extension commands immediately regardless
    // of agent state, while steer()/followUp() explicitly reject them
    // ("extension commands cannot be queued").
    if (text.startsWith("/")) {
      const handled = await this.tryHandleCommand(text);
      if (handled) { return; }
      // Extension command or unknown slash — execute immediately via prompt(),
      // bypassing the steer/queue path below.
      await this.session.prompt(text);
      return;
    }

    if (images && images.length > 0 && !this.activeModelSupportsImages()) {
      const visionModel = this.findVisionModel();
      if (visionModel) {
        await this.setModel(visionModel.provider, visionModel.id);
        this.emit({
          type: "custom-message",
          data: {
            customType: "info",
            content: `Auto-switched to ${visionModel.id} (vision-capable) for image support.`,
            timestamp: Date.now(),
          },
        });
      } else {
        throw new Error(
          `Cannot send images: no vision-capable model available. ` +
          "Add an API key for Claude, GPT-4o, or Gemini to use images."
        );
      }
    }

    if (mode === "steer" || mode === "queue") {
      try {
        if (mode === "queue") {
          await this.session.followUp(text, images);
        } else {
          await this.session.steer(text, images);
        }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        // steer/followUp reject extension commands and prompt templates
        // during streaming — surface the error rather than swallowing it.
        const msg = e?.message ?? String(e);
        piWarn(`sendPrompt ${mode} failed: ${msg}`);
        this.emit({
          type: "custom-message",
          data: {
            customType: "error",
            content: `${mode === "steer" ? "Steer" : "Queue"} failed: ${msg}`,
            timestamp: Date.now(),
          },
        });
      }
    } else {
      const opts: { images?: ImageContent[] } = {};
      if (images && images.length > 0) { opts.images = images; }
      await this.session.prompt(text, opts);
    }
  }

  /** Check whether the active model's input capabilities include images. */
  private activeModelSupportsImages(): boolean {
 
    const rawModel = (this.session)?.model;
    if (!rawModel) { return true; }
    const input = rawModel.input as string[] | undefined;
    return input?.includes("image") ?? true;
  }

  /** Find a vision-capable model from the available scoped models. */
  private findVisionModel(): { provider: string; id: string } | null {
    if (!this.modelRuntime) { return null; }
    for (const cm of this.cycleModels) {
      const m = getRuntimeModel(this.modelRuntime, cm.provider, cm.id);
      if (m?.input?.includes("image")) {
        return { provider: cm.provider, id: cm.id };
      }
    }
    return null;
  }

  /**
   * Reload capability resources without replaying conversation history.
   * The SDK rebuilds its runtime in place, so the current Session and Webview
   * message DOM remain intact even for very long conversations.
   */
  async reloadCapabilities(): Promise<void> {
    if (!this.session) { throw new Error("Pi session is not initialized"); }
    await this.session.reload();
    this.emitCapabilities();
    this.emitSlashCommands();
  }

  /** Reload all resources and replay the current session into the Webview. */
  async reloadContext(): Promise<void> {
    await this.reloadCapabilities();
    await this.emitInitialHistoryReplay();
  }

  /** Try to handle a slash command locally. Returns true if handled,
   *  false if the caller should forward to session.prompt(). */
  private async tryHandleCommand(text: string): Promise<boolean> {
    const spaceIndex = text.indexOf(" ");
    const cmdName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);

    switch (cmdName) {
      // Builtin commands with PiService handlers
      case "model":  await this.cycleModel(); return true;
      case "new":    await this.newSession(); return true;
      case "login":  await this.login(); return true;
      case "logout": await this.logout(); return true;

      // Builtin commands intercepted before session.prompt (like the CLI does).
      // NOTE: /settings, /sessions, /model, /thinking are intercepted by
      // the webview's localSlashCommands and handled via handleSlashCommand.

      case "name": {
        const name = text.slice(6).trim();
        if (name) { this.setSessionName(name); }
        return true;
      }

      case "tree":
        await vscode.commands.executeCommand("pi-on-code.sessions.focus");
        return true;

      case "compact": {
        const compactArgs = text.startsWith("/compact ") ? text.slice(9).trim() : undefined;
        await this.session.compact(compactArgs);
        return true;
      }

      case "export": {
        // Parse optional output path from text
        const exportArgs = text.startsWith("/export ") ? text.slice(8).trim() : undefined;
        const outputPath = exportArgs || vscode.Uri.joinPath(
          getWorkspaceUri(),
          `pi-session-${this.sessionId?.slice(0, 8) ?? "export"}.html`
        ).fsPath;
        const result = await this.session.exportToHtml(outputPath);
        vscode.window.showInformationMessage(`Session exported to: ${result}`);
        return true;
      }

      case "reload": {
        await this.reloadContext();
        return true;
      }

      // Commands that delegate to VS Code commands:
      case "clone":
        await vscode.commands.executeCommand("pi-on-code.cloneSession");
        return true;

      case "tools": {
        await this.pickActiveTools();
        return true;
      }

      case "fork":
      case "resume":
        // These are no-ops via text since they require interactive selection.
        // The UX is available via the Sessions tree context menus.
        return true;

      default:
        // Unknown command — let the caller send to session.prompt (handles
        // extension commands like /tldr, or falls through to the LLM)
        return false;
    }
  }

  async abort(): Promise<void> {
    if (!this.session) {
      piWarn("abort() called but session not initialized — nothing to abort");
      return;
    }
    // Kill running bash processes first — agent.abort() only stops the LLM call,
    // not child processes.  Without this, long-running commands (npm install,
    // test suites, etc.) become orphaned/zombie processes on the system.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { this.session.abortBash?.(); } catch (e: any) { piWarn(`abortBash() failed: ${e?.message ?? e}`); }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { this.session.agent.abort(); } catch (e: any) { piWarn(`abort() failed: ${e?.message ?? e}`); }
  }

  private _renderCustomUi(id: string): void {
    const entry = this._customUis.get(id);
    if (!entry || entry.settled || !entry.component) { return; }

    try {
      const rendered = entry.component.render(entry.width);
      if (!Array.isArray(rendered)) {
        throw new Error("component.render() did not return an array");
      }
      const terminalControlRegex = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;
      const lines = rendered.slice(0, 300).map((line) => String(line)
        .replace(terminalControlRegex, (sequence) => /^\x1b\[[0-9;]*m$/.test(sequence) ? sequence : "")
        .slice(0, 4_000));
      const frame = lines.join("\n");
      if (entry.opened && entry.lastFrame === frame) { return; }

      entry.lastFrame = frame;
      const type = entry.opened ? "custom-ui-update" as const : "custom-ui-open" as const;
      entry.opened = true;
      this.emit({
        type,
        data: {
          id,
          lines,
          columns: entry.width,
          overlay: entry.overlay,
          anchor: entry.anchor,
          ...(entry.maxHeight !== undefined ? { maxHeight: entry.maxHeight } : {}),
        },
      });
    } catch (error: unknown) {
      piWarn(`custom UI render failed: ${error instanceof Error ? error.message : String(error)}`);
      entry.finish(undefined);
    }
  }

  private _showCustomUi(
    factory: RemoteCustomUiFactory,
    options?: RemoteCustomUiOptions,
  ): Promise<unknown> {
    if (this.listeners.length === 0) {
      return Promise.resolve(undefined);
    }

    const id = `custom_${Math.random().toString(36).slice(2, 10)}`;
    const resolvedOverlayOptions = typeof options?.overlayOptions === "function"
      ? options.overlayOptions()
      : options?.overlayOptions;
    const requestedWidth = resolvedOverlayOptions?.width;
    const width = typeof requestedWidth === "number"
      ? Math.max(20, Math.min(240, Math.round(requestedWidth)))
      : 82;
    const requestedMaxHeight = resolvedOverlayOptions?.maxHeight;
    const maxHeight = typeof requestedMaxHeight === "number"
      ? Math.max(1, Math.min(300, requestedMaxHeight))
      : typeof requestedMaxHeight === "string" && /^\d+(?:\.\d+)?%$/.test(requestedMaxHeight)
        ? requestedMaxHeight
        : undefined;

    return new Promise((resolve, reject) => {
      const entry: RemoteCustomUiEntry = {
        component: null,
        width,
        overlay: options?.overlay ?? false,
        anchor: resolvedOverlayOptions?.anchor ?? "center",
        maxHeight,
        lastFrame: null,
        opened: false,
        settled: false,
        finish: (value: unknown) => {
          if (entry.settled) { return; }
          entry.settled = true;
          this._customUis.delete(id);
          if (entry.opened) {
            this.emit({ type: "custom-ui-close", data: { id } });
          }
          try { entry.component?.dispose?.(); } catch { /* best-effort cleanup */ }
          resolve(value);
        },
      };
      this._customUis.set(id, entry);

      const tui = {
        requestRender: () => this._renderCustomUi(id),
      };
      const passthrough = (_roleOrText: string, text?: string): string => text ?? _roleOrText;
      const theme: Record<string, unknown> = {
        fg: passthrough,
        bg: passthrough,
        bold: passthrough,
        italic: passthrough,
        underline: passthrough,
        inverse: passthrough,
        strikethrough: passthrough,
        getFgAnsi: () => "",
        getBgAnsi: () => "",
        getColorMode: () => "truecolor",
      };
      const keybindings = {
        matches: (data: string, keybinding: string): boolean => {
          if (keybinding === "tui.select.up") { return data === "\x1b[A"; }
          if (keybinding === "tui.select.down") { return data === "\x1b[B"; }
          if (keybinding === "tui.select.confirm") { return data === "\r" || data === "\n"; }
          return false;
        },
      };

      Promise.resolve(factory(tui, theme, keybindings, entry.finish))
        .then((component) => {
          if (!component || typeof component.render !== "function") {
            throw new Error("ui.custom() factory did not return a renderable component");
          }
          if (entry.settled) {
            try { component.dispose?.(); } catch { /* best-effort cleanup */ }
            return;
          }
          entry.component = component;
          this._renderCustomUi(id);
        })
        .catch((error: unknown) => {
          this._customUis.delete(id);
          entry.settled = true;
          if (entry.opened) {
            this.emit({ type: "custom-ui-close", data: { id } });
          }
          piWarn(`ui.custom() failed: ${error instanceof Error ? error.message : String(error)}`);
          reject(error);
        });
    });
  }

  handleCustomUiInput(id: string, input: string, columns?: number): void {
    const entry = this._customUis.get(id);
    if (!entry || entry.settled || !entry.component) { return; }
    if (columns !== undefined) {
      entry.width = Math.max(20, Math.min(240, Math.round(columns)));
    }
    try {
      entry.component.handleInput?.(input);
      this._renderCustomUi(id);
    } catch (error: unknown) {
      piWarn(`custom UI input failed: ${error instanceof Error ? error.message : String(error)}`);
      entry.finish(undefined);
    }
  }

  resizeCustomUi(id: string, columns: number): void {
    const entry = this._customUis.get(id);
    if (!entry || entry.settled) { return; }
    const width = Math.max(20, Math.min(240, Math.round(columns)));
    if (entry.width === width) { return; }
    entry.width = width;
    entry.lastFrame = null;
    entry.component?.invalidate?.();
    this._renderCustomUi(id);
  }

  /** Resolve a pending interactive dialog (called from webview-panel.ts). */
  resolveDialog(id: string, value: unknown): void {
    const entry = this._pendingDialogs.get(id);
    if (entry) {
      this._pendingDialogs.delete(id);
      entry.resolve(value);
    }
  }

  /**
   * Show an interactive dialog in the webview and return a Promise.
   * Falls back to synchronous undefined if no listeners are attached
   * (the SDK then uses text-based fallback prompts).
   */
  private _showDialog(
    dialogType: "select" | "confirm" | "input",
    prompt: string,
    extras: { options?: string[]; defaultValue?: string },
  ): Promise<unknown> | undefined {
    if (this.listeners.length === 0) {
      // No webview attached — SDK will fall back to text prompts
      return undefined;
    }
    const id = "dlg_" + Math.random().toString(36).slice(2, 10);
    return new Promise((resolve) => {
      this._pendingDialogs.set(id, { resolve });
      this.emit({
        type: "show_dialog",
        data: {
          dialogType,
          id,
          prompt,
          options: extras.options || [],
          defaultValue: extras.defaultValue || "",
        },
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    });
  }

  async newSession(): Promise<void> {
    if (!this.session) {
      piWarn("newSession() called but session not initialized — creating fresh");
      this.dispose();
      await this.initialize({ fresh: true });
      return;
    }
    // Kill running bash before waiting for idle (otherwise waitForIdle hangs).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { this.session.abortBash?.(); } catch (e: any) { piWarn(`abortBash() failed: ${e?.message ?? e}`); }
    await this.session.agent.waitForIdle();
    this.dispose();
    await this.initialize({ fresh: true });
  }

  /** Resume a past session from a .jsonl file path. Disposes current and re-initializes. */
  async resumeSession(filePath: string): Promise<{ success: boolean; error?: string }> {
    // Kill running bash before waiting for idle.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { this.session?.abortBash?.(); } catch (e: any) { piWarn(`abortBash() failed: ${e?.message ?? e}`); }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { await this.session?.agent.waitForIdle(); } catch (e: any) { piWarn(`waitForIdle() failed: ${e?.message ?? e}`); }
    this.dispose();
    return this.initialize({ openPath: filePath });
  }

  /** After a branch/fork operation, re-emit the branched entries to the webview */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  replayBranchEntries(path: any[]): void {
    this._userMessages = [];
    this.historyEntries = [];
    this.historyCursor = 0;
    this.historyToolResultsById.clear();
    this.historyPageLoading = false;

    // Pre-index tool results by call ID
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolResultsById = new Map<string, any>();
    for (const e of path) {
      if (e.type === "message" && e.message?.role === "toolResult") {
        toolResultsById.set(e.message.toolCallId, e);
      }
    }

    for (const entry of path) {
      if (entry.type === "message" && entry.message) {
        const msg = entry.message;
        if (msg.role === "user") {
          const prompt = splitEditorContext(this.extractTextFromContent(msg.content));
          const images = this.extractImagesFromContent(msg.content);
          if (prompt.text || images.length > 0 || prompt.context?.items.length) {
            if (prompt.text) {
              this._userMessages.push({ id: msg.id ?? `user-${Date.now()}`, text: prompt.text, timestamp: msg.timestamp });
              if (this._userMessages.length > 50) { this._userMessages.shift(); }
            }
            this.emit({
              type: "chat-message",
              data: {
                role: "user",
                content: prompt.text,
                images,
                editorContext: prompt.context?.items,
                entryId: entry.id,
              },
            });
          }
        } else if (msg.role === "assistant") {
          const text = this.extractTextFromContent(msg.content);
          const thinking = this.extractThinkingFromContent(msg.content);
          const toolCalls = this.extractToolCallsFromContent(msg.content);

          // Always emit assistant messages — even tool-only ones with no text.
          // Skipping them makes tool executions invisible on reload/resume.
          this.emit({ type: "assistant-start", data: { messageId: msg.id, entryId: entry.id } });
          // Emit thinking content first, then text
          if (thinking) {
            this.emit({ type: "thinking-delta", data: { delta: thinking } });
            this.emit({ type: "thinking-delta", data: { delta: "", done: true } });
          }
          if (text) {
            this.emit({ type: "stream-delta", data: { delta: text } });
          }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
          this.emit({ type: "assistant-end", data: { stopReason: msg.stopReason, errorMessage: msg.errorMessage, toolCalls: toolCalls.map((tc: any) => tc.id) } });

          for (const tc of toolCalls) {
            const toolResultEntry = toolResultsById.get(tc.id);
            if (tc.name === "bash" || tc.name === "exec") {
              this.emit({ type: "bash-start", data: { toolCallId: tc.id, command: tc.arguments?.command ?? "", entryId: toolResultEntry?.id } });
              const outputText = toolResultEntry?.message ? this.extractTextFromContent(toolResultEntry.message.content) : "";
              this.emit({ type: "bash-end", data: { toolCallId: tc.id, command: tc.arguments?.command ?? "", exitCode: 0, cancelled: false, output: outputText, isError: false, entryId: toolResultEntry?.id } });
            } else {
              this.emit({ type: "tool-start", data: { toolCallId: tc.id, toolName: tc.name, args: tc.arguments, fromMessage: true, entryId: toolResultEntry?.id } });
              if (toolResultEntry?.message) {
                this.emit({ type: "tool-end", data: { toolCallId: tc.id, toolName: tc.name, result: toolResultEntry.message, isError: false, entryId: toolResultEntry?.id } });
              } else {
                this.emit({ type: "tool-end", data: { toolCallId: tc.id, toolName: tc.name, result: { content: [{ type: "text", text: "(forked)" }] }, isError: false, entryId: toolResultEntry?.id } });
              }
            }
          }
        } else if (msg.role === "custom") {
          this.emit({ type: "custom-message", data: { customType: msg.customType, content: msg.content, display: msg.display, details: msg.details, timestamp: msg.timestamp, entryId: entry.id } });
        } else if (msg.role === "bashExecution") {
          const bashEntryId = entry.id ?? `bash-${Date.now()}`;
          this.emit({ type: "bash-start", data: { toolCallId: bashEntryId, command: msg.command ?? "", entryId: entry.id } });
          this.emit({ type: "bash-end", data: { toolCallId: bashEntryId, command: msg.command ?? "", exitCode: msg.exitCode, cancelled: msg.cancelled, output: msg.output ?? "", isError: msg.exitCode !== 0 && msg.exitCode !== null, entryId: entry.id } });
        }
      } else if (entry.type === "compaction") {
        this.emit({ type: "compaction-summary-message", data: { summary: entry.summary ?? "", tokensBefore: entry.tokensBefore ?? 0, timestamp: this._toTimestamp(entry.timestamp), entryId: entry.id } });
      }
    }

    this.reportStatus();
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    if (!this.session || !this.modelRuntime) {
      piWarn(`setModel("${provider}/${modelId}") ignored: session not initialized`);
      return;
    }
    // Try the compatibility registry first, then the canonical runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    let model: any = null;
    if (this.modelRegistry) {
      model = this.modelRegistry.find(provider, modelId);
    }
    if (!model) {
      model = getRuntimeModel(this.modelRuntime, provider, modelId);
    }
    if (model) {
      await this.session.setModel(model);
      this._model = { id: modelId, provider };
      this.cycleIndex = this.cycleModels.findIndex((m) => m.provider === provider && m.id === modelId);
      if (this.cycleIndex === -1) { this.cycleIndex = 0; }
      // session.setModel() delegates persistence to the SDK SessionManager.
      this.reportStatus();
    }
  }

  async cycleModel(): Promise<void> {
    if (!this.session || !this.modelRuntime) {
      vscode.window.showWarningMessage("Pi session not ready yet.");
      return;
    }
    if (this.cycleModels.length === 0) {
      vscode.window.showWarningMessage("No models available. Configure an API key first.");
      return;
    }
    this.cycleIndex = (this.cycleIndex + 1) % this.cycleModels.length;
    const next = this.cycleModels[this.cycleIndex];
    const model = getRuntimeModel(this.modelRuntime, next.provider, next.id);
    if (model) {
      const prevId = this._model?.id ?? "?";
      await this.session.setModel(model);
      this._model = { id: next.id, provider: next.provider };
      if (this.cycleModels.length <= 1) {
        vscode.window.showInformationMessage(`Only ${next.id} configured. Click the model name in the status bar to add more.`);
      } else {
        vscode.window.showInformationMessage(`Model: ${prevId} → ${next.id}`);
      }
      this.reportStatus();
    }
  }

  async setThinkingLevel(level: string): Promise<void> {
    if (!this.session) {
      piWarn(`setThinkingLevel("${level}") ignored: session not initialized`);
      return;
    }
    this.session.setThinkingLevel(level);
    this._thinkingLevel = level;
    this.reportStatus();
    // session.setThinkingLevel() delegates persistence to the SDK SessionManager.
  }

  // ── Default model / thinking persistence ──────────────

  /** Save the current model as the default for future sessions. */
  saveDefaultModel(): void {
    if (!this._model?.provider || !this._model?.id) {
      piWarn("saveDefaultModel() called but no model is active — ignoring");
      return;
    }
    const cfg = vscode.workspace.getConfiguration("pi-on-code");
    cfg.update("defaultModelProvider", this._model.provider, vscode.ConfigurationTarget.Global);
    cfg.update("defaultModelId", this._model.id, vscode.ConfigurationTarget.Global);
  }

  /** Save the current thinking level as the default for future sessions. */
  saveDefaultThinking(): void {
    const cfg = vscode.workspace.getConfiguration("pi-on-code");
    cfg.update("defaultThinkingLevel", this._thinkingLevel, vscode.ConfigurationTarget.Global);
  }

  /** Get the configured default model (if any). */
  getDefaultModel(): { provider: string; id: string } | null {
    const cfg = vscode.workspace.getConfiguration("pi-on-code");
    const provider = cfg.get<string>("defaultModelProvider");
    const id = cfg.get<string>("defaultModelId");
    return (provider && id) ? { provider, id } : null;
  }

  /** Get the configured default thinking level. */
  getDefaultThinking(): string {
    return vscode.workspace.getConfiguration("pi-on-code").get<string>("defaultThinkingLevel") ?? "off";
  }

  /** Get the current context budget (0 = model default). */
  getContextBudget(): number {
    return vscode.workspace.getConfiguration("pi-on-code").get<number>("contextBudget") ?? 0;
  }

  /** Save context budget setting (requires restart to take effect). */
  async setContextBudget(budget: number): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("pi-on-code");
    await cfg.update("contextBudget", budget, vscode.ConfigurationTarget.Global);
    this.reportStatus();
  }

  // ── Settings, models, scoped models ──────────────────

  get autoCompactionEnabled(): boolean { return this._autoCompactionEnabled; }
  get autoRetryEnabled(): boolean { return this._autoRetryEnabled; }
  get showImages(): boolean { return this._showImages; }
  get autoCollapseToolResults(): boolean {
    return vscode.workspace.getConfiguration("pi-on-code").get<boolean>("autoCollapseToolResults", true);
  }
  get autoAttachActiveEditor(): boolean {
    return vscode.workspace.getConfiguration("pi-on-code").get<boolean>(
      "autoAttachActiveEditor",
      true,
    );
  }
  get userMessages(): Array<{ id: string; text: string; timestamp?: number }> { return this._userMessages; }

  /** Get available models from the model registry (for dynamic model pickers). */
  async getAvailableModels(): Promise<Array<{ provider: string; id: string; name?: string; cost?: { input: number; output: number }; contextWindow?: number }>> {
    if (!this.modelRegistry) { return []; }
    try {
      const available = await this.modelRegistry.getAvailable();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  /** Format model specs (pricing + context window) for QuickPick detail. Returns empty string if no data. */
  static formatModelDetail(cost?: { input: number; output: number }, contextWindow?: number): string {
    const parts: string[] = [];
    if (cost) {
      parts.push(`$${cost.input}/$${cost.output} per M tokens`);
    }
    if (contextWindow) {
      parts.push(`${Math.round(contextWindow / 1000)}K context`);
    }
    return parts.join(" · ");
  }

  /** Open a QuickPick to choose a model, set it on this session, and optionally save as default. */
  async pickModel(): Promise<boolean> {
    interface ModelItem { label: string; provider: string; modelId: string; cost?: { input: number; output: number }; contextWindow?: number }
    let models: ModelItem[] = [];

    try {
      const available = await this.getAvailableModels();
      if (available.length > 0) {
        models = available.map((m) => ({
          label: m.name || m.id,
          provider: m.provider,
          modelId: m.id,
          cost: m.cost,
          contextWindow: m.contextWindow,
        }));
      }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      piWarn(`pickModel: getAvailableModels failed (${e.message}), using static fallback`);
    }

    // Fallback: static list of common models (no pricing — only SDK-reported pricing is shown)
    if (models.length === 0) {
      models = [
        { label: "Claude Sonnet 4.5", provider: "anthropic", modelId: "claude-sonnet-4-5" },
        { label: "Claude Haiku 4.5", provider: "anthropic", modelId: "claude-haiku-4-5" },
        { label: "Claude Opus 4.5", provider: "anthropic", modelId: "claude-opus-4-5" },
        { label: "GPT 4o", provider: "openai", modelId: "gpt-4o" },
        { label: "Gemini 2.5 Pro", provider: "google", modelId: "gemini-2.5-pro" },
        { label: "DeepSeek V3", provider: "deepseek", modelId: "deepseek-chat" },
      ];
    }

    const currentId = this.model?.id;
    const defModel = this.getDefaultModel();
    const items = models.map((m) => {
      const isDefault = defModel && m.provider === defModel.provider && m.modelId === defModel.id;
      return {
        label: `${m.label}${m.modelId === currentId ? " $(check)" : ""}${isDefault ? " \u2605" : ""}`,
        description: m.provider,
        detail: PiService.formatModelDetail(m.cost, m.contextWindow),
        provider: m.provider,
        modelId: m.modelId,
        isDefault,
      };
    });

    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select model (\u2605 = default)", matchOnDetail: true });
    if (!picked) { return false; }

    await this.setModel(picked.provider, picked.modelId);

    // Offer to save as default if not already
    if (!picked.isDefault) {
      const save = await vscode.window.showQuickPick(
        [{ label: "\u2605 Save as default", description: "Use this model for future sessions" }],
        { placeHolder: `Use as default?` },
      );
      if (save) { this.saveDefaultModel(); }
    }

    return true;
  }

  /** Open a QuickPick to choose a thinking level, set it on this session, and optionally save as default. */
  async pickThinkingLevel(): Promise<boolean> {
    const levels = [
      { label: "off", description: "No thinking" },
      { label: "minimal", description: "Minimal thinking" },
      { label: "low", description: "Brief thinking" },
      { label: "medium", description: "Balanced thinking" },
      { label: "high", description: "Extended thinking" },
      { label: "xhigh", description: "Maximum thinking" },
    ];
    const current = this.thinkingLevel;
    const defLevel = this.getDefaultThinking();
    const items = levels.map((l) => {
      const isDefault = l.label === defLevel;
      return {
        label: `${l.label === current ? "$(check) " : ""}${l.label}${isDefault ? " \u2605" : ""}`,
        description: l.description,
        level: l.label,
        isDefault,
      };
    });

    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select thinking level (\u2605 = default)" });
    if (!picked) { return false; }

    await this.setThinkingLevel(picked.level);

    // Offer to save as default if not already
    if (!picked.isDefault) {
      const save = await vscode.window.showQuickPick(
        [{ label: "\u2605 Save as default", description: "Use this thinking level for future sessions" }],
        { placeHolder: `Use "${picked.level}" thinking as the default?` },
      );
      if (save) { this.saveDefaultThinking(); }
    }

    return true;
  }

  /** Get scoped models from the session */
  getScopedModels(): Array<{ provider: string; id: string; thinkingLevel: string }> {
    if (!this.session || !this.session.scopedModels) { return []; }
    return this.session.scopedModels
      .filter((s: Record<string, unknown>) => s.model !== null && s.model !== undefined)
      .map((s: Record<string, unknown>) => ({
        provider: (s.model as Record<string, unknown>).provider as string,
        id: (s.model as Record<string, unknown>).id as string,
        thinkingLevel: (s.thinkingLevel as string) ?? "off",
      }));
  }

  emitScopedModels(): void {
    this.emit({ type: "scoped-models-update", data: { models: this.getScopedModels() } });
  }

  emitSettings(): void {
    this.emit({
      type: "settings-update",
      data: {
        autoCompaction: this._autoCompactionEnabled,
        autoRetry: this._autoRetryEnabled,
        showImages: this._showImages,
        autoCollapseToolResults: this.autoCollapseToolResults,
        autoAttachActiveEditor: this.autoAttachActiveEditor,
      },
    });
  }

  async toggleAutoCompaction(): Promise<boolean> {
    if (!this.session) { return this._autoCompactionEnabled; }
    this._autoCompactionEnabled = !this._autoCompactionEnabled;
    if (typeof this.session.setAutoCompactionEnabled === "function") {
      await this.session.setAutoCompactionEnabled(this._autoCompactionEnabled);
    }
    this.emitSettings();
    return this._autoCompactionEnabled;
  }

  async toggleAutoRetry(): Promise<boolean> {
    if (!this.session) { return this._autoRetryEnabled; }
    this._autoRetryEnabled = !this._autoRetryEnabled;
    this.emitSettings();
    return this._autoRetryEnabled;
  }

  async toggleShowImages(): Promise<boolean> {
    this._showImages = !this._showImages;
    this.emitSettings();
    return this._showImages;
  }

  async toggleAutoCollapseToolResults(): Promise<boolean> {
    const config = vscode.workspace.getConfiguration("pi-on-code");
    const inspected = config.inspect<boolean>("autoCollapseToolResults");
    const target = inspected?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await config.update("autoCollapseToolResults", !this.autoCollapseToolResults, target);
    this.emitSettings();
    return this.autoCollapseToolResults;
  }

  async toggleAutoAttachActiveEditor(): Promise<boolean> {
    const config = vscode.workspace.getConfiguration("pi-on-code");
    const inspected = config.inspect<boolean>("autoAttachActiveEditor");
    const target = inspected?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await config.update("autoAttachActiveEditor", !this.autoAttachActiveEditor, target);
    this.emitSettings();
    return this.autoAttachActiveEditor;
  }

  async setEffort(effort: string): Promise<void> {
    this._effort = effort;
    if (this.session && typeof this.session.setEffort === "function") {
      await this.session.setEffort(effort);
    }
    this.reportStatus();
  }

  /** Generate a short 3-word tab title summary for the first user input in a session. */
  async generateTabSummary(userInput: string): Promise<string | null> {
    if (!this.modelRuntime || !this._model) { return null; }

    try {
      const provider = this._model.provider;
      const modelId = this._model.id;
      if (!provider || !modelId) { return null; }
      const model = getRuntimeModel(this.modelRuntime, provider, modelId);
      if (!model) { return null; }

      const context = {
        systemPrompt: "Generate a concise 3-word summary of the following user request. Respond with ONLY the three words, lowercase, no punctuation, no quotes, no explanation.",
        messages: [
          { role: "user", content: userInput, timestamp: Date.now() },
        ],
      };

      const result = await completeWithModelRuntime(this.modelRuntime, model, context, {
        maxTokens: 20,
      });

      const text = this.extractTextFromContent(result.content);
      if (text) {
        // Clean up: take first line, trim, limit to ~40 chars
        return text.split("\n")[0].trim().replace(/^["']|["']$/g, "").slice(0, 40);
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Set a runtime API key (not persisted to disk) */
  setRuntimeApiKey(provider: string, key: string): void {
    if (this.modelRuntime && typeof this.modelRuntime.setRuntimeApiKey === "function") {
      this.modelRuntime.setRuntimeApiKey(provider, key);
    }
  }

  // ── Usage / token stats ──────────────────────────────

  getUsageStats(): {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextPercent: number | null;
    contextWindow: number;
  } {
    if (!this.sessionManager) {
      return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextPercent: null, contextWindow: 0 };
    }

    const entries = this.sessionManager.getEntries();
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalCost = 0;

    for (const entry of entries) {
      if (entry.type === "message" && entry.message?.role === "assistant") {
        const usage = entry.message.usage;
        if (usage) {
          totalInput += usage.input ?? 0;
          totalOutput += usage.output ?? 0;
          totalCacheRead += usage.cacheRead ?? 0;
          totalCacheWrite += usage.cacheWrite ?? 0;
          totalCost += usage.cost?.total ?? 0;
        }
      }
    }

    let contextPercent: number | null = null;
    let contextWindow = 0;
    try {
      const contextUsage = this.session?.getContextUsage?.();
      if (contextUsage) {
        contextPercent = contextUsage.percent;
        contextWindow = contextUsage.contextWindow;
      }
    } catch (e: unknown) { piWarn(`Non-critical failure (ignored): ${e instanceof Error ? e.message : String(e)}`); }

    return { input: totalInput, output: totalOutput, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite, cost: totalCost, contextPercent, contextWindow };
  }

  // ── Getters ────────────────────────────────────────────

  get isStreaming(): boolean { return this._isStreaming; }
  get model(): { id?: string; name?: string; provider?: string } | null { return this._model; }
  get thinkingLevel(): string { return this._thinkingLevel; }

  /** Replace pending follow-up messages while preserving steering messages. */
  async replaceFollowUpQueue(messages: string[]): Promise<void> {
    if (!this.session) { throw new Error("Pi session not initialized"); }
    const normalized = messages.map((message) => message.trim()).filter(Boolean);
    const previous = this.session.clearQueue() as { steering: string[]; followUp: string[] };

    try {
      for (const steering of previous.steering) {
        await this.session.steer(steering);
      }
      for (const followUp of normalized) {
        await this.session.followUp(followUp);
      }
    } catch (error) {
      // A turn can settle while the queue is being edited. Restore the prior
      // queue best-effort so editing never silently discards pending work.
      this.session.clearQueue();
      try {
        for (const steering of previous.steering) { await this.session.steer(steering); }
        for (const followUp of previous.followUp) { await this.session.followUp(followUp); }
      } catch (restoreError: unknown) {
        piWarn(`Failed to restore queue after edit: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
      }
      throw error;
    }
  }

  /** Promote a follow-up message to steering without discarding its siblings. */
  async promoteToSteer(text: string): Promise<void> {
    if (!this.session) { return; }
    const previous = this.session.clearQueue() as { steering: string[]; followUp: string[] };
    const followUpIndex = previous.followUp.indexOf(text);
    if (followUpIndex !== -1) { previous.followUp.splice(followUpIndex, 1); }
    for (const steering of previous.steering) { await this.session.steer(steering); }
    await this.session.steer(text);
    for (const followUp of previous.followUp) { await this.session.followUp(followUp); }
  }

  /** Clear all queued messages. */
  async clearQueue(): Promise<void> {
    if (!this.session) { return; }
    this.session.clearQueue();
  }
  get effort(): string { return this._effort; }
  get sdkRoot(): string | null { return this._piRoot; }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  get sessionManagerInstance(): any { return this.sessionManager; }
  /** The file path of the session file on disk (for persistence across reloads). */
  get sessionFilePath(): string | null {
    return this.sessionManager?.getSessionFile?.() ?? null;
  }
  get sessionIdValue(): string | null { return this.sessionId; }
  get initialized(): boolean { return this.session !== null; }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  get rawSession(): any { return this.session; }
  /** Expose the model registry for dynamic model pickers in the webview */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  get modelRegistryInstance(): any { return this.modelRegistry; }

  /** Get the session display name from the session manager, if set. */
  get sessionName(): string | undefined {
    return this.sessionManager?.getSessionName?.();
  }

  /** Persist a display name to the session file so it survives tab close. */
  setSessionName(name: string): void {
    if (!name || !this.session?.setSessionName) { return; }
    this.session.setSessionName(name);
    this.reportStatus();
  }

  // ── Tools ───────────────────────────────────────────────

  /** Get all configured tools available for selection. */
  getAllTools(): Array<{ name: string; description: string; source: string }> {
    if (!this.session || typeof this.session.getAllTools !== "function") { return []; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.session.getAllTools().map((t: any) => ({
      name: t.name,
      description: t.description ?? "",
      source: t.sourceInfo?.source ?? "sdk",
    }));
  }

  /** Get names of currently active tools. */
  getActiveToolNames(): string[] {
    if (!this.session || typeof this.session.getActiveToolNames !== "function") { return []; }
    return this.session.getActiveToolNames();
  }

  /** Set which tools are active for the next agent turn. */
  setActiveTools(toolNames: string[]): void {
    if (!this.session || typeof this.session.setActiveToolsByName !== "function") {
      piWarn("setActiveTools: session not initialized or method unavailable");
      return;
    }
    this.session.setActiveToolsByName(toolNames);
    // Verify the update took effect
    const actualNames = this.session.getActiveToolNames();
    piLog(`setActiveTools: requested ${toolNames.length}, actual ${actualNames.length} — ${actualNames.join(", ") || "(none)"}`);
    // Use the SessionManager API so fresh-session header creation and tree
    // bookkeeping stay under SDK control. Raw appends can create a headerless
    // file before the SDK's first flush, causing EEXIST on the first response.
    if (typeof this.sessionManager?.appendCustomEntry === "function") {
      this.sessionManager.appendCustomEntry("pi-on-code.active-tools", { toolNames });
    } else {
      piWarn("setActiveTools: SessionManager.appendCustomEntry unavailable; selection will not persist");
    }
    piLog(`setActiveTools: ${toolNames.length} tools active`);
  }

  /** Restore the latest active-tool selection, including the legacy raw entry format. */
  private _restoreActiveToolsFromSession(): void {
    const entries = this.sessionManager?.getEntries?.() ?? [];
    if (!entries.length) { return; }
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      const toolNames = e.type === "custom" && e.customType === "pi-on-code.active-tools"
        ? e.data?.toolNames
        : e.type === "tools_active_change"
          ? e.toolNames
          : undefined;
      if (Array.isArray(toolNames) && toolNames.every((name) => typeof name === "string")) {
        this.session.setActiveToolsByName(toolNames);
        piLog(`Restored active tools from session: ${toolNames.join(", ") || "(none)"}`);
        return;
      }
    }
  }

  /** Open a QuickPick to select which tools are active for this session. */
  async pickActiveTools(): Promise<boolean> {
    if (!this.session) {
      vscode.window.showWarningMessage("Pi session not ready yet.");
      return false;
    }

    const allTools = this.getAllTools();
    if (allTools.length === 0) {
      vscode.window.showInformationMessage("No tools available.");
      return false;
    }

    const activeNames = new Set(this.getActiveToolNames());
    piLog(`pickActiveTools: ${activeNames.size} active tools — ${[...activeNames].join(", ") || "(none)"}`);

    // Group by source for a cleaner pick list
    const builtinTools = allTools.filter((t) => t.source === "builtin");
    const bridgeTools = allTools.filter((t) => t.source === "sdk" && t.name.startsWith("vscode_"));
    const extensionTools = allTools.filter((t) => t.source !== "builtin" && !t.name.startsWith("vscode_"));

    const items: vscode.QuickPickItem[] = [];

    const addGroup = (label: string, tools: typeof allTools): void => {
      if (tools.length === 0) { return; }
      const icon = label === "Built-in" ? "tools" : label === "VS Code Bridge" ? "extensions" : "symbol-misc";
      items.push({ label: `$(${icon}) ${label}`, kind: vscode.QuickPickItemKind.Separator });
      for (const t of tools) {
        items.push({
          label: t.name,
          description: t.description,
          detail: t.source,
          picked: activeNames.has(t.name),
        });
      }
    };

    addGroup("Built-in", builtinTools);
    addGroup("VS Code Bridge", bridgeTools);
    addGroup("Extension", extensionTools);

    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: `Select tools (${activeNames.size} active)`,
      matchOnDescription: true,
    });

    if (!picked) { return false; }

    const selectedNames = picked
      .filter((p) => p.kind !== vscode.QuickPickItemKind.Separator)
      .map((p) => p.label);

    this.setActiveTools(selectedNames);

    const added = selectedNames.filter((n) => !activeNames.has(n)).length;
    const removed = activeNames.size - selectedNames.filter((n) => activeNames.has(n)).length;
    const parts: string[] = [];
    if (added > 0) { parts.push(`+${added}`); }
    if (removed > 0) { parts.push(`-${removed}`); }
    vscode.window.showInformationMessage(
      `Tools updated: ${selectedNames.length} active${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`,
    );

    return true;
  }

  // ── Login / Logout ─────────────────────────────────────

  /**
   * Show the login flow for a provider.
   * Mirrors the pi CLI's /login command:
   * 1. Select auth type (subscription/OAuth vs API key)
   * 2. Select provider
   * 3. For OAuth: open browser and complete OAuth flow
   * 4. For API key: prompt for key and save it
   */
  async login(): Promise<void> {
    if (!this.modelRuntime || !this.modelRegistry) {
      throw new Error("Pi session not initialized");
    }

    // ── Step 1: Auth type selector ─────────────────────
    const authType = await this.pickAuthType();
    if (!authType) { return; } // cancelled

    // ── Step 2: Provider selector ───────────────────────
    const providerChoice = await this.pickLoginProvider(authType);
    if (!providerChoice) { return; } // cancelled

    // ── Step 3: Execute login ───────────────────────────
    if (providerChoice.authType === "oauth") {
      await this.doOAuthLogin(providerChoice.id, providerChoice.name);
    } else if (providerChoice.id === "amazon-bedrock") {
      await this.showInfoMessage(
        "Amazon Bedrock uses AWS credentials. Configure an AWS profile, IAM keys, or role-based credentials.",
      );
    } else {
      await this.doApiKeyLogin(providerChoice.id, providerChoice.name);
    }
  }

  /** Show the auth type picker: Subscription (OAuth) vs API Key */
  private async pickAuthType(): Promise<"oauth" | "api_key" | undefined> {
    const ITEMS = [
      { label: "Use a subscription", authType: "oauth" as const, description: "OAuth login for Anthropic, GitHub Copilot, OpenAI Codex" },
      { label: "Use an API key", authType: "api_key" as const, description: "Enter an API key for any provider" },
    ];
    const pick = await this.showQuickPick(ITEMS, "Select authentication method:");
    return pick?.authType;
  }

  /** Show provider picker for a given auth type */
  private async pickLoginProvider(
    authType: "oauth" | "api_key",
  ): Promise<{ id: string; name: string; authType: string } | undefined> {
    const options = this.getLoginProviderOptions(authType);
    if (options.length === 0) {
      const label = authType === "oauth" ? "No subscription providers available." : "No API key providers available.";
      await this.showInfoMessage(label);
      return undefined;
    }
    const pick = await this.showQuickPick(options, `Select ${authType === "oauth" ? "subscription" : "API key"} provider:`);
    return pick;
  }

  /** Build the list of provider options for login */
  private getLoginProviderOptions(
    authType: "oauth" | "api_key",
  ): Array<{ id: string; name: string; authType: string; label: string; description: string }> {
    const KNOWN_OAUTH_PROVIDERS = ["anthropic", "github-copilot", "openai-codex"];
    const options: Array<{ id: string; name: string; authType: string; label: string; description: string }> = [];

    if (authType === "oauth") {
      for (const providerId of KNOWN_OAUTH_PROVIDERS) {
        const displayName = this.modelRegistry.getProviderDisplayName(providerId);
        const authStatus = this.modelRegistry.getProviderAuthStatus(providerId);
        options.push({
          id: providerId,
          name: displayName,
          authType: "oauth",
          label: displayName,
          description: authStatus?.configured ? "$(check) Already configured" : "",
        });
      }
    } else {
      // API key providers — all model providers that aren't OAuth-only
      const allModels = this.modelRegistry.getAll();
      const seenProviders = new Set<string>();
      for (const model of allModels) {
        const providerId = model.provider;
        if (seenProviders.has(providerId)) { continue; }
        seenProviders.add(providerId);
        if (KNOWN_OAUTH_PROVIDERS.includes(providerId)) { continue; }
        const displayName = this.modelRegistry.getProviderDisplayName(providerId);
        const authStatus = this.modelRegistry.getProviderAuthStatus(providerId);
        options.push({
          id: providerId,
          name: displayName,
          authType: "api_key",
          label: displayName,
          description: authStatus?.configured
            ? `$(check) Already configured (${authStatus.source})`
            : "",
        });
      }
    }

    return options.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Show a VS Code quick pick (wraps showQuickPick since it's async and returns proper type) */
  private async showQuickPick<T extends { label: string; description?: string }>(
    items: T[],
    placeHolder: string,
  ): Promise<T | undefined> {
    const vscode = await import("vscode");
    const picked = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true });
    return picked;
  }

  /** Show an info message */
  private async showInfoMessage(message: string): Promise<void> {
    const vscode = await import("vscode");
    await vscode.window.showInformationMessage(message);
  }

  /** Show an error message */
  private async showErrorMessage(message: string): Promise<void> {
    const vscode = await import("vscode");
    await vscode.window.showErrorMessage(message);
  }

  /**
   * Execute OAuth login flow for a provider.
   * Opens the browser, handles callbacks, and waits for completion.
   */
  private async doOAuthLogin(providerId: string, providerName: string): Promise<void> {
    const vscode = await import("vscode");
    const previousModel = this._model;

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Logging in to ${providerName}...`,
          cancellable: true,
        },
        async (progress, token) => {
          const abortController = new AbortController();
          token.onCancellationRequested(() => abortController.abort());

          await this.modelRuntime.login(providerId, "oauth", {
            onAuth: (info: { url: string; instructions?: string }) => {
              vscode.env.openExternal(vscode.Uri.parse(info.url));
              if (info.instructions) {
                progress.report({ message: info.instructions });
              }
            },
            prompt: async (opts: { message?: string; type?: string }) => {
              return (await vscode.window.showInputBox({
                prompt: opts?.message ?? "Enter value",
                password: opts?.type === "secret",
                ignoreFocusOut: true,
              })) ?? "";
            },
            onProgress: (message: string) => {
              progress.report({ message });
            },
            onManualCodeInput: () => {
              return new Promise<string>((resolve, reject) => {
                token.onCancellationRequested(() => reject(new Error("Login cancelled")));
                vscode.window
                  .showInputBox({
                    prompt: "Paste redirect URL below, or complete login in browser:",
                    ignoreFocusOut: true,
                  })
                  .then((value) => {
                    if (value) { resolve(value); }
                    else { reject(new Error("Login cancelled")); }
                  });
              });
            },
            signal: abortController.signal,
          });

          progress.report({ message: "Login successful!" });
        },
      );

      // Refresh model registry and try to select a model for the provider
      await this.modelRegistry.refresh();
      await this.completeLogin(providerId, providerName, "oauth", previousModel);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      if (error.message !== "Login cancelled") {
        await this.showErrorMessage(`Failed to login to ${providerName}: ${error.message ?? error}`);
      }
    }
  }

  /**
   * Execute API key login flow for a provider.
   */
  private async doApiKeyLogin(providerId: string, providerName: string): Promise<void> {
    const vscode = await import("vscode");
    const previousModel = this._model;

    try {
      const apiKey = await vscode.window.showInputBox({
        prompt: `Enter API key for ${providerName}:`,
        password: true,
        placeHolder: "sk-...",
        validateInput: (value) => (value.trim() ? undefined : "API key required"),
        ignoreFocusOut: true,
      });

      if (!apiKey || !apiKey.trim()) {
        return; // cancelled
      }

      const trimmedKey = apiKey.trim();
      await this.modelRuntime.login(providerId, "api_key", {
        prompt: async () => trimmedKey,
      });
      await this.modelRegistry.refresh();
      await this.completeLogin(providerId, providerName, "api_key", previousModel);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      if (error.message !== "Login cancelled") {
        await this.showErrorMessage(`Failed to save API key for ${providerName}: ${error.message ?? error}`);
      }
    }
  }

  /** After login, try to select a default model for the provider */
  private async completeLogin(
    providerId: string,
    providerName: string,
    authType: string,
    previousModel: { id?: string; provider?: string } | null,
  ): Promise<void> {
    const actionLabel = authType === "oauth" ? `Logged in to ${providerName}` : `Saved API key for ${providerName}`;

    // Try to select a default model for the provider if the current model is "unknown"
    if (this.modelRuntime && (!previousModel || previousModel.provider === "unknown")) {
      const availableModels = this.modelRegistry.getAvailable();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      const providerModels = availableModels.filter((m: any) => m.provider === providerId);
      if (providerModels.length > 0) {
        try {
          await this.setModel(providerId, providerModels[0].id);
          await this.showInfoMessage(`${actionLabel}. Selected ${providerModels[0].id}.`);
        } catch {
          await this.showInfoMessage(`${actionLabel}.`);
        }
        return;
      }
    }

    await this.showInfoMessage(`${actionLabel}.`);
  }

  /**
   * Show the logout flow for a provider.
   * Mirrors the pi CLI's /logout command.
   */
  async logout(): Promise<void> {
    if (!this.modelRuntime || !this.modelRegistry) {
      throw new Error("Pi session not initialized");
    }

    // Build list of providers that have credentials saved
    const options: Array<{ id: string; name: string; label: string; description: string }> = [];
    const credentials = await this.modelRuntime.listCredentials();
    for (const entry of credentials) {
      const displayName = this.modelRegistry.getProviderDisplayName(entry.providerId);
      options.push({
        id: entry.providerId,
        name: displayName,
        label: displayName,
        description: entry.type === "oauth" ? "OAuth subscription" : "API key",
      });
    }

    if (options.length === 0) {
      await this.showInfoMessage(
        "No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
      );
      return;
    }

    const pick = await this.showQuickPick(
      options.sort((a, b) => a.name.localeCompare(b.name)),
      "Select provider to logout:",
    );
    if (!pick) { return; }

    try {
      await this.modelRuntime.logout(pick.id);
      await this.modelRegistry.refresh();
      const message =
        pick.description === "OAuth subscription"
          ? `Logged out of ${pick.name}`
          : `Removed stored API key for ${pick.name}. Environment variables and models.json config are unchanged.`;
      await this.showInfoMessage(message);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      await this.showErrorMessage(`Logout failed: ${error.message ?? error}`);
    }
  }

  // ── Cleanup ────────────────────────────────────────────

  dispose(): void {
    // Force-flush the session file to disk before tearing down.
    // The SDK defers all disk writes until the first assistant message
    // arrives, so if the model is slow or the user closes the tab early,
    // entries (including session_info with the tab name) exist only in
    // memory and would be lost.  _rewriteFile bypasses the deferral.
 
    const sm = this.sessionManager;
    if (sm && !sm.flushed && typeof sm._rewriteFile === "function") {
      try { sm._rewriteFile(); } catch (e: unknown) { piWarn(`Best-effort failure: ${e instanceof Error ? e.message : String(e)}`); }
    }
    // Kill any running bash processes before tearing down the session.
    // Without this, processes orphaned by session close survive as zombies.
    try { this.session?.abortBash?.(); } catch (e: unknown) { piWarn(`Best-effort failure: ${e instanceof Error ? e.message : String(e)}`); }
    for (const entry of [...this._customUis.values()]) { entry.finish(undefined); }
    if (this._widgetTimer) { clearInterval(this._widgetTimer); this._widgetTimer = null; }
    this.initialHistoryReplayEvents = [];
    this.capturingInitialHistoryReplay = false;
    this.unsubscribe?.();
    this.session?.dispose();
    this.session = null;
    this.unsubscribe = null;
    this.SDK = null;
    this.modelRuntime = null;
    this.resourceLoader = null;
  }
}
