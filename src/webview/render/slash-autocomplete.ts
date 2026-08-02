import { html, safe } from "./html.js";

export interface SearchableSlashCommand {
  cmd: string;
  desc: string;
}

/** Return a single-token Slash autocomplete query, including `:` and `-`. */
export function getSlashCommandFilter(value: string): string | null {
  return /^\/[^\s/]*$/.test(value) ? value : null;
}

function slashMatchScore(command: SearchableSlashCommand, query: string): number | null {
  const name = command.cmd.toLowerCase().replace(/^\/+/, "");
  const description = command.desc.toLowerCase();
  if (name === query) { return 0; }
  if (name.startsWith(query)) { return 1; }
  if (name.split(/[:_-]+/).some((part) => part.startsWith(query))) { return 2; }
  if (name.includes(query)) { return 3; }
  if (description.split(/\s+/).some((word) => word.startsWith(query))) { return 4; }
  if (description.includes(query)) { return 5; }
  return null;
}

/** Match and rank command names and descriptions, ignoring the leading slash. */
export function filterSlashCommands<T extends SearchableSlashCommand>(
  commands: T[],
  filter: string,
): T[] {
  const query = filter.trim().toLowerCase().replace(/^\/+/, "");
  if (!query) { return commands; }
  return commands
    .map((command, index) => ({ command, index, score: slashMatchScore(command, query) }))
    .filter((match): match is { command: T; index: number; score: number } => match.score !== null)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((match) => match.command);
}

/** Build trusted source-badge markup while escaping the label text itself. */
export function renderSlashSourceLabel(sourceLabel: string): ReturnType<typeof safe> | "" {
  return sourceLabel
    ? safe(html`<span class="slash-source">${sourceLabel}</span>`)
    : "";
}
