import { html, safe } from "./html.js";

/** Build trusted source-badge markup while escaping the label text itself. */
export function renderSlashSourceLabel(sourceLabel: string): ReturnType<typeof safe> | "" {
  return sourceLabel
    ? safe(html`<span class="slash-source">${sourceLabel}</span>`)
    : "";
}
