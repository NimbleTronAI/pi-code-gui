import * as vscode from "vscode";
import type { PiService } from "./pi-service.js";

function safeRegister(context: vscode.ExtensionContext, command: string, callback: (...args: unknown[]) => unknown): void {
  try {
    context.subscriptions.push(vscode.commands.registerCommand(command, callback));
  } catch (e: unknown) {
    console.log(`[pi-gui] Command "${command}" already registered, skipping phase-4 duplicate: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function registerPhase4Commands(
  context: vscode.ExtensionContext,
  // Resolve the live target PiService per invocation (see phase3-commands).
  // The toggles previously had no guard at all, so calling one after the bound
  // session was disposed would throw on a null service.
  resolve: () => PiService | undefined,
): void {
  safeRegister(context, "pi-code-gui.login", async () => {
    const piService = resolve();
    if (!piService) { vscode.window.showWarningMessage("No active Pi session."); return; }
    try {
      await piService.login();
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`Login failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  safeRegister(context, "pi-code-gui.resumeSession", async () => {
    vscode.commands.executeCommand("pi-code-gui.sendSlashCommand", "/resume");
  });

  // NOTE: compact / reloadContext are registered directly in extension.ts
  // (active-session aware). Not registered here — doing so only duplicated those
  // ids and produced "already registered" log noise.

  safeRegister(context, "pi-code-gui.toggleAutoCompaction", async () => {
    const piService = resolve();
    if (!piService) { vscode.window.showWarningMessage("No active Pi session."); return; }
    const enabled = await piService.toggleAutoCompaction();
    vscode.window.showInformationMessage(`Auto-compaction ${enabled ? "enabled" : "disabled"}.`);
  });

  safeRegister(context, "pi-code-gui.toggleAutoRetry", async () => {
    const piService = resolve();
    if (!piService) { vscode.window.showWarningMessage("No active Pi session."); return; }
    const enabled = await piService.toggleAutoRetry();
    vscode.window.showInformationMessage(`Auto-retry ${enabled ? "enabled" : "disabled"}.`);
  });
}
