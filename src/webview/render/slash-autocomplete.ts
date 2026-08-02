import { html, safe } from "./html.js";

export interface SearchableSlashCommand {
  cmd: string;
  desc: string;
}

/** Return a single-token Slash autocomplete query, including `:` and `-`. */
export function getSlashCommandFilter(value: string): string | null {
  return /^\/[^\s/]*$/.test(value) ? value : null;
}

/** Match anywhere in a command name or description, ignoring the leading slash. */
export function filterSlashCommands<T extends SearchableSlashCommand>(
  commands: T[],
  filter: string,
): T[] {
  const query = filter.trim().toLowerCase().replace(/^\/+/, "");
  if (!query) { return commands; }
  return commands.filter((command) => {
    const name = command.cmd.toLowerCase().replace(/^\/+/, "");
    return name.includes(query) || command.desc.toLowerCase().includes(query);
  });
}

/** Build trusted source-badge markup while escaping the label text itself. */
export function renderSlashSourceLabel(sourceLabel: string): ReturnType<typeof safe> | "" {
  return sourceLabel
    ? safe(html`<span class="slash-source">${sourceLabel}</span>`)
    : "";
}
