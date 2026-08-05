// Consent for custom message renderers.
//
// A pi extension can register a renderer by shipping SOURCE CODE, which the webview injects as a
// <script> carrying the CSP nonce and executes. That is arbitrary JS in the webview — precisely
// what the nonce-based CSP exists to prevent — and the payload travels over the message bus, so
// any future path that lets model or remote content reach it becomes a full compromise.
//
// The feature is legitimate (a pi extension already runs arbitrary code in the extension host),
// so this doesn't remove it — it makes it explicit and revocable: the user is asked once per
// custom type, the answer is remembered in globalState, and a refusal degrades to the normal
// markdown rendering rather than breaking the session.
import * as vscode from "vscode";
import { piDebug } from "./logger.js";

const STATE_KEY = "pi-code-gui.allowedRenderers";

let _ctx: vscode.ExtensionContext | null = null;
/** In-flight prompts, so a burst of registrations for one type asks only once. */
const _pending = new Map<string, Promise<boolean>>();

export function initRendererConsent(context: vscode.ExtensionContext): void { _ctx = context; }

function decisions(): Record<string, boolean> {
  return _ctx?.globalState.get<Record<string, boolean>>(STATE_KEY) ?? {};
}

/** Ask (once) whether `customType` may run a custom renderer. Remembered across sessions. */
export async function confirmRendererConsent(customType: string): Promise<boolean> {
  if (!_ctx) { return false; }                       // no context — fail closed
  const known = decisions()[customType];
  if (typeof known === "boolean") { return known; }
  const inFlight = _pending.get(customType);
  if (inFlight) { return inFlight; }

  const ask = (async (): Promise<boolean> => {
    const ALLOW = "Allow", DENY = "Don't allow";
    const choice = await vscode.window.showWarningMessage(
      `A Pi extension wants to render "${customType}" messages using its own code, which runs inside the chat view. Allow it?`,
      { modal: false, detail: "Only allow this for extensions you trust. Denying falls back to standard markdown rendering." },
      ALLOW, DENY,
    );
    // Dismissing is NOT consent, and is not remembered — we ask again next time.
    if (choice !== ALLOW && choice !== DENY) { return false; }
    const allowed = choice === ALLOW;
    await _ctx?.globalState.update(STATE_KEY, { ...decisions(), [customType]: allowed });
    piDebug(`Custom renderer "${customType}" ${allowed ? "allowed" : "denied"} by the user.`);
    return allowed;
  })();

  _pending.set(customType, ask);
  try { return await ask; } finally { _pending.delete(customType); }
}

/** Clear all remembered decisions (command: "Reset custom renderer permissions"). */
export async function resetRendererConsent(): Promise<void> {
  await _ctx?.globalState.update(STATE_KEY, {});
}

/** Test seam. */
export function __setRendererConsentContextForTest(ctx: vscode.ExtensionContext | null): void { _ctx = ctx; }
