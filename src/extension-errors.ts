/**
 * Pure, vscode-free classifiers that turn raw runtime/SDK error strings into
 * structured, user-facing diagnostics.
 *
 * The extension can't control which Pi extensions a user installs or how their
 * provider configs are written, so it must recognize the common failure shapes
 * and communicate them clearly — instead of leaking a raw stderr flood (Rust
 * runtime) or a cryptic SDK throw (TypeScript runtime). Kept DOM/vscode-free so
 * it can be unit-tested headlessly; the surfaces that show these to the user
 * live in pi-service.ts (TS path) and rust-process.ts / rust-service.ts (Rust).
 */

export interface ProviderConfigError {
  provider: string;
  /** Env var name(s) the SDK tried, in order, to resolve the key from. */
  envVars: string[];
  /** Short, user-facing headline. */
  title: string;
  /** What went wrong, in plain language. */
  detail: string;
  /** Concrete next step to fix it. */
  remediation: string;
}

// e.g. `Failed to resolve API key for provider "deepseek" from environment variable: ENV`
//  or  `... from environment variables: OPENAI_API_KEY, OPENAI_KEY`
const PROVIDER_KEY_RE =
  /Failed to resolve .*?\bprovider "([^"]+)" from environment variables?:\s*(.+?)\s*$/i;

/** Build the conventional env-var name for a provider, e.g. deepseek -> DEEPSEEK_API_KEY. */
function conventionalKeyVar(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}_API_KEY`;
}

/**
 * Recognize the SDK's "could not resolve an API key for provider X" failure and
 * turn it into an actionable diagnostic. Returns null for unrelated messages.
 */
export function classifyProviderConfigError(message: string | undefined | null): ProviderConfigError | null {
  if (!message) { return null; }
  const m = PROVIDER_KEY_RE.exec(message);
  if (!m) { return null; }
  const provider = m[1].trim();
  const envVars = m[2].split(",").map((s) => s.trim()).filter(Boolean);
  if (!provider || envVars.length === 0) { return null; }

  // A single var literally named ENV is the tell-tale of the obsolete
  // "$ENV:NAME" reference syntax: the current SDK parser reads `$ENV` as a
  // reference to a variable called ENV and stops at the `:`.
  const legacyEnvSyntax = envVars.length === 1 && envVars[0] === "ENV";
  const plural = envVars.length > 1;
  const remediation = legacyEnvSyntax
    ? `The provider's apiKey is using the obsolete "$ENV:NAME" syntax. In your models.json, change it to the \${NAME} form — e.g. "\${${conventionalKeyVar(provider)}}".`
    : `Set ${envVars.join(" or ")} in the environment, or reference it in models.json as "\${${envVars[0]}}".`;

  return {
    provider,
    envVars,
    title: `${provider}: API key could not be resolved`,
    detail: `The ${provider} provider config expects environment variable${plural ? "s" : ""} ${envVars.join(", ")}, which ${plural ? "are" : "is"} not set.`,
    remediation,
  };
}

/**
 * Compose a multi-line, user-facing message for a provider-key error, or null
 * when `raw` isn't one. Callers use `humanizeProviderError(raw) ?? raw` to
 * upgrade the message in place without changing the event shape.
 */
export function humanizeProviderError(raw: string | undefined | null): string | null {
  const e = classifyProviderConfigError(raw);
  return e ? `${e.title}\n\n${e.detail}\n\n${e.remediation}` : null;
}

export type RustLoadErrorKind = "digest-mismatch" | "unsupported-module" | "load-failed";

export interface RustLoadError {
  kind: RustLoadErrorKind;
  /** The offending package, when it can be extracted (e.g. "pi-web-access"). */
  packageName?: string;
  detail: string;
  remediation?: string;
}

/** One-line, user-facing message for a classified Rust extension-load failure. */
export function formatRustLoadError(e: RustLoadError): string {
  const who = e.packageName ? `Pi extension "${e.packageName}"` : "A Pi extension";
  return `${who} failed to load (${e.kind}): ${e.detail}${e.remediation ? ` ${e.remediation}` : ""}`;
}

/** classify + format a raw Rust-stderr line in one step, or null if not a load failure. */
export function humanizeRustLoadError(line: string | undefined | null): string | null {
  const e = classifyRustLoadError(line);
  return e ? formatRustLoadError(e) : null;
}

const NODE_MODULES_PKG_RE = /node_modules\/((?:@[^/]+\/)?[^/'"]+)/;

/**
 * Classify a single Rust-runtime stderr line about a failed extension/skill
 * load. Returns null for lines that aren't load failures (ordinary stderr).
 * Checked most-specific first: a digest line also contains "Failed to load…".
 */
export function classifyRustLoadError(line: string | undefined | null): RustLoadError | null {
  if (!line) { return null; }

  if (/digest[_ ]mismatch|provenance verification failed/i.test(line)) {
    const pkg = (/\bfor (?:npm:)?((?:@[^/\s]+\/)?[^\s:]+):/.exec(line) || [])[1];
    return {
      kind: "digest-mismatch",
      packageName: pkg,
      detail: "Package contents changed since they were last trusted.",
      remediation: pkg
        ? `Run \`pi remove ${pkg}\` then \`pi install ${pkg}\` to re-trust the new version.`
        : undefined,
    };
  }

  const mod = /Unsupported module specifier:\s*(\S+)/i.exec(line);
  if (mod) {
    const pkg = (NODE_MODULES_PKG_RE.exec(line) || [])[1];
    return {
      kind: "unsupported-module",
      packageName: pkg,
      detail: `Imports ${mod[1]}, which the Rust runtime's module loader doesn't support.`,
      remediation: pkg
        ? `${pkg} can't load in the Rust runtime as-is — pin an older version that avoids ${mod[1]}, or use it under the TypeScript runtime.`
        : undefined,
    };
  }

  if (/Failed to load (?:skills|prompts|themes|extensions)/i.test(line)) {
    return { kind: "load-failed", detail: line.replace(/^.*?Failed to load/i, "Failed to load").trim().slice(0, 300) };
  }

  return null;
}
