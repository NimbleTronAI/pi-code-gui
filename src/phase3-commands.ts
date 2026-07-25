import * as vscode from "vscode";
import { piError, piLog } from "./logger.js";
import type { PiService } from "./pi-service.js";

function safeRegister(context: vscode.ExtensionContext, command: string, callback: (...args: unknown[]) => unknown): void {
  try {
    context.subscriptions.push(vscode.commands.registerCommand(command, callback));
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    if (err.message.includes("already registered") || err.message.includes("already exists")) {
      piLog(`Command "${command}" already registered, skipping phase-3 duplicate.`);
    } else {
      piError(`Failed to register command "${command}": ${err.stack ?? err.message}`);
    }
  }
}

export function registerPhase3Commands(
  context: vscode.ExtensionContext,
  piService: PiService,
): void {
  safeRegister(context, "pi-on-code.pickModel", async () => {
    if (!piService.initialized) {
      vscode.window.showWarningMessage("Pi is still initializing. Try again in a moment.");
      return;
    }
    vscode.commands.executeCommand("pi-on-code.sendSlashCommand", "/model");
  });

  safeRegister(context, "pi-on-code.cycleModel", async () => {
    if (!piService.initialized) {
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

  safeRegister(context, "pi-on-code.pickThinkingLevel", async () => {
    if (!piService.initialized) {
      vscode.window.showWarningMessage("Pi is still initializing. Try again in a moment.");
      return;
    }
    await piService.pickThinkingLevel();
  });

  safeRegister(context, "pi-on-code.cycleThinkingLevel", async () => {
    if (!piService.initialized) {
      vscode.window.showWarningMessage("Pi is still initializing. Try again in a moment.");
      return;
    }
    try {
      await piService.setThinkingLevel(
        nextLevel(piService.thinkingLevel),
      );
      vscode.window.showInformationMessage(`Thinking: ${piService.thinkingLevel}`);
    } catch (e: unknown) {
      vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    }
  });

  safeRegister(context, "pi-on-code.pickFork", async () => {
    vscode.window.showInformationMessage("Fork via /fork command in chat.");
  });

  safeRegister(context, "pi-on-code.exportSession", async () => {
    vscode.window.showInformationMessage("Export via /export command in chat.");
  });
}

function nextLevel(cur: string): string {
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
  const i = levels.indexOf(cur);
  return levels[(i + 1) % levels.length];
}
