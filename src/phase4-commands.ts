import * as vscode from "vscode";
import { piLog } from "./logger.js";
import type { PiService } from "./pi-service.js";

function safeRegister(context: vscode.ExtensionContext, command: string, callback: (...args: unknown[]) => unknown): void {
  try {
    context.subscriptions.push(vscode.commands.registerCommand(command, callback));
  } catch (e: unknown) {
    piLog(`Command "${command}" already registered, skipping phase-4 duplicate: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function registerPhase4Commands(
  context: vscode.ExtensionContext,
  piService: PiService,
): void {
  safeRegister(context, "pi-on-code.login", async () => {
    try {
      await piService.login();
    } catch (e: unknown) {
      vscode.window.showErrorMessage(`Login failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  safeRegister(context, "pi-on-code.resumeSession", async () => {
    vscode.commands.executeCommand("pi-on-code.sendSlashCommand", "/resume");
  });

  safeRegister(context, "pi-on-code.compact", async () => {
    vscode.commands.executeCommand("pi-on-code.sendSlashCommand", "/compact");
  });

  safeRegister(context, "pi-on-code.toggleAutoCompaction", async () => {
    const enabled = await piService.toggleAutoCompaction();
    vscode.window.showInformationMessage(`Auto-compaction ${enabled ? "enabled" : "disabled"}.`);
  });

  safeRegister(context, "pi-on-code.toggleAutoRetry", async () => {
    const enabled = await piService.toggleAutoRetry();
    vscode.window.showInformationMessage(`Auto-retry ${enabled ? "enabled" : "disabled"}.`);
  });

  safeRegister(context, "pi-on-code.reloadContext", async () => {
    try {
      await piService.newSession();
      vscode.window.showInformationMessage("Context reloaded.");
    } catch (e: unknown) {
      vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    }
  });
}
