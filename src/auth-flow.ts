// Provider login / logout flow (pi-coding-agent >= 0.80.8 ModelRuntime auth), extracted
// from PiService (both audits flagged the ~180-line auth block in the god class).
//
// vscode-free by injection: all UI (quick picks, input boxes, progress, browser-open,
// notifications) goes through the AuthUI seam, so the ORCHESTRATION — not just the pure
// list builders — is driven headlessly in auth-flow.test.ts. PiService.makeAuthUI() wires
// the real vscode implementations.
//
// NOTE: the OAuth path here is wired to the pi-ai AuthInteraction contract but was not
// live-verified end-to-end (only the api-key + logout round-trip was) — see
// agent-wiki/operations/sdk-resolution.md. The extraction preserves both paths verbatim.
/* eslint-disable @typescript-eslint/no-explicit-any -- ModelRuntime + provider/credential objects are dynamically typed */

/** The VS Code UI surface the auth flow needs — injected so the flow is testable. */
export interface AuthUI {
  quickPick<T extends { label: string }>(items: T[], opts: { placeHolder?: string; matchOnDescription?: boolean; ignoreFocusOut?: boolean }): Promise<T | undefined>;
  inputBox(opts: { prompt?: string; placeHolder?: string; password?: boolean; ignoreFocusOut?: boolean }): Promise<string | undefined>;
  /** Run `task` inside a cancellable progress notification; `report` updates the message,
   *  `signal` aborts when the user cancels. */
  withProgress(title: string, task: (report: (message: string) => void, signal: AbortSignal) => Promise<void>): Promise<void>;
  openExternal(url: string): void;
  info(message: string): void;
  error(message: string): void;
}

export interface AuthFlowDeps {
  modelRuntime: any;
  getActiveModel(): { id?: string; provider?: string } | null;
  setModel(provider: string, id: string): Promise<void>;
  ui: AuthUI;
}

export type AuthType = "oauth" | "api_key";

export interface LoginProviderItem { label: string; id: string; name: string; description: string; }
export interface LogoutItem { label: string; id: string; description: string; }

/** Providers supporting `authType`, annotated with configured status and sorted by name —
 *  the QuickPick items for provider selection. Pure. */
export function buildLoginProviderItems(
  providers: any[],
  authType: AuthType,
  isConfigured: (id: string) => boolean,
): LoginProviderItem[] {
  return providers
    .filter((p) => (authType === "oauth" ? !!p.auth?.oauth : !!p.auth?.apiKey))
    .map((p) => ({ label: p.name, id: p.id, name: p.name, description: isConfigured(p.id) ? "$(check) already configured" : "" }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Stored-credential QuickPick items (provider display name + credential kind), sorted. Pure. */
export function buildLogoutItems(creds: any[], getProviderName: (id: string) => string): LogoutItem[] {
  return creds
    .map((c) => ({ label: getProviderName(c.providerId), id: c.providerId, description: c.type === "oauth" ? "OAuth subscription" : "API key" }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Adapt a pi-ai `AuthInteraction` (prompt/notify) to the injected UI. Serves BOTH the
 *  api-key (`secret`/`text`) and OAuth (`select`/`manual_code` + `auth_url`/`device_code`
 *  notifications) flows. */
export function makeAuthInteraction(report: (message: string) => void, signal: AbortSignal, ui: AuthUI): any {
  return {
    signal,
    prompt: async (p: any): Promise<string> => {
      if (p.type === "select") {
        const options = ((p.options ?? []) as any[]).map((o) => ({ label: o.label, description: o.description, id: o.id }));
        const pick = await ui.quickPick(options, { placeHolder: p.message, ignoreFocusOut: true });
        if (!pick) { throw new Error("Login cancelled"); }
        return pick.id;
      }
      // "text" | "secret" | "manual_code"
      const value = await ui.inputBox({ prompt: p.message, placeHolder: p.placeholder, password: p.type === "secret", ignoreFocusOut: true });
      if (value === undefined) { throw new Error("Login cancelled"); }
      return value;
    },
    notify: (event: any): void => {
      if (event.type === "auth_url") {
        ui.openExternal(event.url);
        report(event.instructions ?? "Complete the login in your browser…");
      } else if (event.type === "device_code") {
        ui.openExternal(event.verificationUri);
        report(`Enter code ${event.userCode} at ${event.verificationUri}`);
      } else if (event.message) {
        report(event.message);
      }
    },
  };
}

/** After login, auto-select a model for the provider when none is active yet. */
async function completeLogin(deps: AuthFlowDeps, providerId: string, providerName: string, previousModel: { id?: string; provider?: string } | null): Promise<void> {
  const { modelRuntime: rt, ui } = deps;
  if (!previousModel || previousModel.provider === "unknown") {
    try {
      const available = (await rt.getAvailable()) as any[];
      const first = available.find((m) => m.provider === providerId);
      if (first) {
        await deps.setModel(providerId, first.id);
        ui.info(`Logged in to ${providerName}. Selected ${first.id}.`);
        return;
      }
    } catch { /* fall through to the plain confirmation */ }
  }
  ui.info(`Logged in to ${providerName}.`);
}

/** The /login flow: pick auth type → pick provider → run the provider-owned login through
 *  the interaction adapter → refresh the catalog → auto-select a model. */
export async function runLogin(deps: AuthFlowDeps): Promise<void> {
  const { modelRuntime: rt, ui } = deps;
  if (!rt) { throw new Error("Pi session not initialized"); }

  const typePick = await ui.quickPick(
    [
      { label: "Use a subscription", authType: "oauth" as const, description: "OAuth login (Anthropic, GitHub Copilot, OpenAI Codex, …)" },
      { label: "Use an API key", authType: "api_key" as const, description: "Enter an API key for a provider" },
    ],
    { placeHolder: "Select authentication method" },
  );
  if (!typePick) { return; }
  const authType = typePick.authType;

  const items = buildLoginProviderItems(rt.getProviders?.() ?? [], authType, (id) => !!rt.hasConfiguredAuth?.(id));
  if (items.length === 0) {
    ui.info(`No providers support ${authType === "oauth" ? "subscription" : "API key"} login.`);
    return;
  }
  const provider = await ui.quickPick(items, { placeHolder: `Select ${authType === "oauth" ? "subscription" : "API key"} provider`, matchOnDescription: true });
  if (!provider) { return; }

  const previousModel = deps.getActiveModel();
  try {
    await ui.withProgress(`Logging in to ${provider.name}…`, async (report, signal) => {
      await rt.login(provider.id, authType, makeAuthInteraction(report, signal, ui));
    });
    await rt.refresh(); // async — reload the dynamic catalog with the new credential
    await completeLogin(deps, provider.id, provider.name, previousModel);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (!/cancel|abort/i.test(msg)) { ui.error(`Failed to log in to ${provider.name}: ${msg}`); }
  }
}

/** The /logout flow: list stored credentials → pick one → remove it. Env vars / models.json
 *  config are untouched. */
export async function runLogout(deps: AuthFlowDeps): Promise<void> {
  const { modelRuntime: rt, ui } = deps;
  if (!rt) { throw new Error("Pi session not initialized"); }
  const creds = (await rt.listCredentials()) as any[];
  if (!creds || creds.length === 0) {
    ui.info("No stored credentials to remove. /logout only removes credentials saved via login; environment variables and models.json config are unchanged.");
    return;
  }
  const pick = await ui.quickPick(buildLogoutItems(creds, (id) => rt.getProvider?.(id)?.name ?? id), { placeHolder: "Select provider to log out" });
  if (!pick) { return; }
  try {
    await rt.logout(pick.id);
    await rt.refresh();
    ui.info(pick.description === "OAuth subscription"
      ? `Logged out of ${pick.label}.`
      : `Removed stored API key for ${pick.label}. Environment variables and models.json config are unchanged.`);
  } catch (e: any) {
    ui.error(`Logout failed: ${e?.message ?? e}`);
  }
}
