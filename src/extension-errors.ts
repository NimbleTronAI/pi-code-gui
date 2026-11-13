/**
 * Pure, vscode-free classifiers that turn raw SDK error strings into structured,
 * user-facing diagnostics.
 *
 * The extension can't control how a user's provider configs are written, so it
 * must recognize the common failure shapes and communicate them clearly instead of
 * leaking a cryptic SDK throw. Kept DOM/vscode-free so it can be unit-tested
 * headlessly; the surfaces that show these to the user are agent-events.ts and
 * sdk-service.ts.
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

/**
 * Turn a terminal `stopReason` on an assistant message into something a user can act on.
 *
 * A turn that ends with `stopReason: "error"` used to render as SILENCE: the webview only
 * handled "aborted", so everything else fell through and the conversation simply stopped
 * mid-thought: the panel showed a reply that trailed off as though the model had lost interest.
 *
 * Returns null for ordinary completions, so callers can push the result unconditionally.
 */
export function explainAgentStop(stopReason: string | undefined, errorMessage: string | undefined): string | null {
  const detail = (errorMessage ?? "").trim();

  // Deliberately NOT an allowlist of benign reasons — guessing which strings are harmless is
  // how the original bug happened, and a novel failure reason would go silent again. Explain
  // the two reasons known to mean failure, plus ANY reason carrying an error message, which is
  // itself evidence that something went wrong whatever the reason is called.
  const isFailure = stopReason === "error" || stopReason === "aborted" || detail !== "";
  if (!stopReason || !isFailure) { return null; }

  if (stopReason === "aborted") { return detail || "Operation aborted."; }
  return detail
    ? `**The turn ended early** (\`${stopReason}\`): ${detail}`
    : `**The turn ended early** (\`${stopReason}\`) with no reason given.`;
}
