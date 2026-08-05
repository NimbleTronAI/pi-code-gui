import * as vscode from "vscode";
import type { PiService } from "./pi-service.js";
import { piDebug, piWarn } from "./logger.js";

function safeRegister(context: vscode.ExtensionContext, command: string, callback: (...args: unknown[]) => unknown): void {
  try {
    context.subscriptions.push(vscode.commands.registerCommand(command, callback));
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    if (err.message.includes("already registered") || err.message.includes("already exists")) {
      piDebug(`Command "${command}" already registered, skipping phase-3 duplicate.`);
    } else {
      piWarn(`Failed to register command "${command}": ${err.message}`);
    }
  }
}

export function registerPhase3Commands(
  context: vscode.ExtensionContext,
  // Resolve the live target PiService on each invocation. These commands are
  // registered once per host lifetime; binding to the first session's service
  // would leave them pointing at a disposed session after a tab change/close.
  resolve: () => PiService | undefined,
): void {
  // NOTE: pickModel / exportSession are registered directly in extension.ts
  // (active-session aware). They are intentionally NOT registered here — doing so
  // duplicated those ids and only produced "already registered" log noise.

  safeRegister(context, "pi-code-gui.cycleModel", async () => {
    const piService = resolve();
    if (!piService?.initialized) {
      vscode.window.showWarningMessage("Pi is still initializing. Try again in a moment.");
      return;
    }
    try {
      await piService.cycleModel();
      vscode.window.showInformationMessage(`Model: ${piService.model?.id ?? "unknown"}`);
    } catch (e: unknown) {
      vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    }
  });

  safeRegister(context, "pi-code-gui.pickThinkingLevel", async () => {
    const piService = resolve();
    if (!piService?.initialized) {
      vscode.window.showWarningMessage("Pi is still initializing. Try again in a moment.");
      return;
    }
    await piService.pickThinkingLevel();
  });

  safeRegister(context, "pi-code-gui.cycleThinkingLevel", async () => {
    const piService = resolve();
    if (!piService?.initialized) {
      vscode.window.showWarningMessage("Pi is still initializing. Try again in a moment.");
      return;
    }
    try {
      // Toggle the Thinking axis on/off. Off→on restores the last reasoning level
      // used (falling back to the model's highest); on→off disables thinking.
      // toggleThinking surfaces its own notice (and returns false) when there's
      // nothing to toggle, so only confirm the composed state on a real change.
      if (await piService.toggleThinking()) {
        vscode.window.showInformationMessage(piService.thinkingStatus().text);
      }
    } catch (e: unknown) {
      vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    }
  });

  safeRegister(context, "pi-code-gui.pickFork", async () => {
    vscode.window.showInformationMessage("Fork via /fork command in chat.");
  });
}
