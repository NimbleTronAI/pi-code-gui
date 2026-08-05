// ── Safe HTML Builder ─────────────────────────────────────────
//
// Layer 2 of the Component System Proposal: a tagged template
// literal that auto-escapes all interpolated values, eliminating
// HTML injection via string concatenation.
//
// Usage:
//   import { html, safe } from "./html.js";
//
//   // Auto-escaped:
//   const el = html`<div class="tool-block" data-path="${filePath}">
//     ${toolHeader}
//   </div>`;
//
//   // Trusted HTML bypasses escaping:
//   const el = html`<div>${safe(renderMarkdown(content))}</div>`;
//
// The `safe()` marker is the ONLY way to inject raw HTML.  All
// other interpolated values go through textContent assignment,
// which is immune to HTML injection.

/** Marker type for trusted HTML that bypasses auto-escaping. */
interface SafeHtml {
  __safe: true;
  html: string;
}

/**
 * Mark a string as safe HTML that should NOT be escaped.
 * Use this for output from renderMarkdown(), highlightCode(),
 * renderFileContent(), and other functions that produce trusted HTML.
 */
export function safe(html: string): SafeHtml {
  return { __safe: true, html };
}

function isSafeHtml(value: unknown): value is SafeHtml {
  return (
    typeof value === "object" &&
    value !== null &&
    "__safe" in value &&
    (value as SafeHtml).__safe === true
  );
}

/**
 * Escape HTML-special characters via textContent assignment.
 * This is the same approach as engine.ts's escapeHtml() —
 * the browser handles all encoding correctly.
 */
import { escapeHtml as escapeText } from "../../shared/escape-html.js";

/**
 * Tagged template literal for safe HTML construction.
 *
 * Every `${...}` interpolated value is auto-escaped unless
 * wrapped in a `safe()` marker.  Null/undefined values produce
 * an empty string.
 *
 * Returns a plain string — use with innerHTML or morphRender.
 */
export function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  let result = "";
  for (let i = 0; i < strings.length; i++) {
    result += strings[i];
    if (i < values.length) {
      const value = values[i];
      if (value === null || value === undefined) {
        // skip — produces empty string
        continue;
      }
      if (isSafeHtml(value)) {
        result += value.html;
      } else {
        result += escapeText(String(value));
      }
    }
  }
  return result;
}
