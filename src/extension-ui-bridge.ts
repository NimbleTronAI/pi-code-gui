// Extension UI bridge — the webview-facing UIContext handed to pi extensions through
// session.bindExtensions(). Without it, extensions like pi-tldr have hasUI=false and their
// notify/setWidget calls silently do nothing.
//
// Extracted from PiService (both dual-runtime audits flagged it: a ~160-line Proxy layer
// with zero test coverage that coupled the orchestrator to TUI-extension internals). It's
// vscode-free — every effect is an injected callback (emit / showDialog / now) — so the
// widget rendering, ANSI stripping, status formatting, dialog routing, and the
// unknown-method Proxy no-op are all driven headlessly in extension-ui-bridge.test.ts.
import { piWarn } from "./logger.js";
import type { PiServiceEvent } from "./types.js";

export interface UIBridgeDeps {
  emit: (event: PiServiceEvent) => void;
  /** Show an interactive dialog in the webview; resolves with the user's choice, or
   *  undefined when no webview is attached (the SDK then falls back to text prompts). */
  showDialog: (
    type: "select" | "confirm" | "input",
    prompt: string,
    extras: { options?: string[]; defaultValue?: string },
  ) => Promise<unknown> | undefined;
  /** Clock for the idle-widget sweep + change timestamps. Defaults to Date.now; tests
   *  inject a fake to drive the stale-widget cleanup deterministically. */
  now?: () => number;
}

export interface ExtensionUIBridge {
  /** The Proxy-wrapped UIContext to pass to `session.bindExtensions({ uiContext })`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uiContext: any;
  /** Stop the stale-widget sweep timer (call from PiService.dispose). */
  dispose(): void;
}

/** A widget not updated for this long is cleared — kills orphaned animations when an
 *  extension forgets stopWidgetAnimation (e.g. pi-subagents async jobs). */
const MAX_WIDGET_IDLE_MS = 30_000;
const WIDGET_SWEEP_MS = 10_000;
/** Strip ANSI escape codes — widgets render in an HTML webview, so terminal color/OSC
 *  sequences are noise. Covers SGR (`\x1b[…m`), OSC (`\x1b]…BEL/ST`), and APC (`\x1b_…`). */
const ANSI_REGEX = /\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[_][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Build the extension UIContext + its idle-widget sweep. Effects flow through `deps`. */
export function createExtensionUIBridge(deps: UIBridgeDeps): ExtensionUIBridge {
  const { emit, showDialog } = deps;
  const now = deps.now ?? Date.now;

  // Active widgets keyed by widget key (rendered text + last-update time per widget).
  const widgetTexts = new Map<string, string>();
  const widgetLastUpdate = new Map<string, number>();

  const timer = setInterval(() => {
    const t = now();
    for (const [key, lastUpdate] of widgetLastUpdate) {
      if (t - lastUpdate > MAX_WIDGET_IDLE_MS) {
        widgetTexts.delete(key);
        widgetLastUpdate.delete(key);
        emit({ type: "widget-update", data: { key, content: null } });
      }
    }
  }, WIDGET_SWEEP_MS);
  if (timer.unref) { timer.unref(); }

  // Base uiContext with the methods we explicitly support; wrapped in a Proxy below so any
  // unknown method call (from TUI-only extensions) silently no-ops instead of throwing.
  const baseUIContext = {
    notify: (message: string, level: "info" | "error") => {
      if (level === "error") { piWarn(`ui.notify(error): ${message.substring(0, 120)}`); }
      emit({
        type: "custom-message",
        data: { customType: level === "error" ? "error" : "extension-notify", content: message, timestamp: now() },
      });
    },
    setWidget: (key: string, factory: unknown) => {
      if (factory === undefined || factory === null) {
        widgetTexts.delete(key);
        widgetLastUpdate.delete(key);
        emit({ type: "widget-update", data: { key, content: null } });
        return;
      }
      if (typeof factory !== "function") {
        piWarn(`setWidget("${key}"): factory is not a function (got ${typeof factory})`);
        return;
      }
      try {
        // Minimal Theme stub (fg returns text without ANSI — the webview is HTML) + a
        // minimal TUI stub: pi-tldr and similar widgets only use theme.
        const theme = { fg: (_role: string, text: string) => text };
        const tui = {};
        const component = (factory as (tui: unknown, theme: unknown) => { render?: (width: number) => string[] })(tui, theme);
        if (!component || typeof component.render !== "function") {
          piWarn(`setWidget("${key}"): component.render is not a function`);
          return;
        }
        const lines = component.render(80);
        if (!Array.isArray(lines)) {
          piWarn(`setWidget("${key}"): render() did not return an array`);
          return;
        }
        const content = lines.map((l: string) => l.replace(ANSI_REGEX, "")).join("\n");
        if (widgetTexts.get(key) === content) { return; } // unchanged — skip the emit
        widgetTexts.set(key, content);
        widgetLastUpdate.set(key, now());
        emit({ type: "widget-update", data: { key, content } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        // Widget rendering is best-effort; don't crash the session.
        piWarn(`setWidget("${key}"): render error: ${e?.message ?? e}`);
      }
    },
    // Interactive methods — resolve when the user dismisses the webview dialog; undefined
    // when no webview is attached (SDK falls back to text prompts).
    select: (prompt: string, options: string[]) => showDialog("select", prompt, { options }),
    confirm: (prompt: string) => showDialog("confirm", prompt, {}),
    input: (prompt: string, defaultValue?: string) => showDialog("input", prompt, { defaultValue }),
    custom: () => undefined,
    // TUI compatibility stubs discovered via the Proxy at runtime.
    setToolsExpanded: (_expanded: boolean) => { /* stub — TUI widget expand/collapse */ },
    getToolsExpanded: () => false,
    requestRender: () => { /* stub — TUI repaint, not needed in webview */ },
    onTerminalInput: (_handler: unknown) => { /* stub */ },
    setStatus: (key: string, status: string | null) => {
      // Show as a widget card so status is visible in VS Code.
      if (status === null || status === undefined) {
        widgetTexts.delete(`status-${key}`);
        widgetLastUpdate.delete(`status-${key}`);
        emit({ type: "widget-update", data: { key: `status-${key}`, content: null } });
      } else {
        const content = `**${key}** ${status}`;
        widgetTexts.set(`status-${key}`, content);
        // Stamp the sweep timer too: it iterates widgetLastUpdate, so a status-* widget that
        // never wrote here could never be idle-evicted — defeating the sweep for exactly the
        // widgets an extension leaves behind.
        widgetLastUpdate.set(`status-${key}`, now());
        emit({ type: "widget-update", data: { key: `status-${key}`, content } });
      }
    },
  };

  // Proxy: warn on an unknown method call so we can see what TUI methods extensions expect,
  // then no-op gracefully instead of crashing "x is not a function".
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

  return { uiContext, dispose: () => clearInterval(timer) };
}
