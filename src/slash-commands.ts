// Slash-command assembly + parsing — the pure, vscode-free core of PiService's slash
// handling (both audits flagged the god class carrying this). The dispatch itself
// (tryHandleCommand) stays in PiService because its actions ARE PiService methods; what's
// extracted here is the testable logic: which commands the webview should offer, and how a
// command line splits into name + argument.
import type { BackendCapabilities } from "./pi-backend.js";

export interface SlashCommand { cmd: string; desc: string; source: string; }

/** The GUI/session commands the extension services directly, available on every runtime
 *  (the pickers + session ops branch internally, so they work from chat regardless of
 *  backend). */
const GUI_COMMANDS: readonly SlashCommand[] = [
  { cmd: "/model", desc: "Switch model", source: "builtin" },
  { cmd: "/new", desc: "Start new session", source: "builtin" },
  { cmd: "/compact", desc: "Compact context", source: "builtin" },
  { cmd: "/settings", desc: "Open settings", source: "builtin" },
  { cmd: "/login", desc: "Configure provider authentication", source: "builtin" },
  { cmd: "/logout", desc: "Remove provider authentication", source: "builtin" },
  { cmd: "/debug", desc: "Dump webview state for troubleshooting", source: "builtin" },
];

/** Assemble the full slash-command list the webview autocompletes: the active backend's
 *  agent-provided commands, the always-available GUI/session commands, then the
 *  capability-gated ones. Pure — a function of (agentCommands, capabilities), no runtime
 *  branch (capabilities are data flags). Rust's RPC can't run the gated ones from chat, so
 *  they're advertised only where the backend can service them. */
export function buildSlashCommandList(agentCommands: SlashCommand[], caps: BackendCapabilities): SlashCommand[] {
  const result: SlashCommand[] = [...agentCommands, ...GUI_COMMANDS];
  if (caps.fork) {
    result.push({ cmd: "/resume", desc: "Resume a previous session", source: "builtin" });
    result.push({ cmd: "/fork", desc: "Fork session from message", source: "builtin" });
  }
  if (caps.exportHtml && caps.kind === "typescript") {
    result.push({ cmd: "/export", desc: "Export session to HTML", source: "builtin" });
  }
  if (caps.toolsPicker) {
    result.push({ cmd: "/tools", desc: "Select which tools are active", source: "builtin" });
  }
  return result;
}

/** Split a slash-command line into its command name (no leading "/") and trimmed argument
 *  (everything after the first space; "" when there's none). Replaces ad-hoc `text.slice(N)`
 *  magic-number parsing in the dispatcher. */
export function parseSlashCommand(text: string): { cmd: string; arg: string } {
  const spaceIndex = text.indexOf(" ");
  if (spaceIndex === -1) { return { cmd: text.slice(1), arg: "" }; }
  return { cmd: text.slice(1, spaceIndex), arg: text.slice(spaceIndex + 1).trim() };
}
