// ── Safe ANSI SGR parser ────────────────────────────────────
// Converts terminal styling into structured segments. Non-SGR control
// characters are discarded; callers render segment text with textContent.

export interface AnsiStyle {
  foreground?: string;
  background?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strikethrough?: boolean;
}

export interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

const ANSI_COLORS = [
  "var(--vscode-terminal-ansiBlack, #000000)",
  "var(--vscode-terminal-ansiRed, #cd3131)",
  "var(--vscode-terminal-ansiGreen, #0dbc79)",
  "var(--vscode-terminal-ansiYellow, #e5e510)",
  "var(--vscode-terminal-ansiBlue, #2472c8)",
  "var(--vscode-terminal-ansiMagenta, #bc3fbc)",
  "var(--vscode-terminal-ansiCyan, #11a8cd)",
  "var(--vscode-terminal-ansiWhite, #e5e5e5)",
  "var(--vscode-terminal-ansiBrightBlack, #666666)",
  "var(--vscode-terminal-ansiBrightRed, #f14c4c)",
  "var(--vscode-terminal-ansiBrightGreen, #23d18b)",
  "var(--vscode-terminal-ansiBrightYellow, #f5f543)",
  "var(--vscode-terminal-ansiBrightBlue, #3b8eea)",
  "var(--vscode-terminal-ansiBrightMagenta, #d670d6)",
  "var(--vscode-terminal-ansiBrightCyan, #29b8db)",
  "var(--vscode-terminal-ansiBrightWhite, #ffffff)",
] as const;

function cloneStyle(style: AnsiStyle): AnsiStyle {
  return { ...style };
}

function sanitizeText(text: string): string {
  // Keep printable text, tabs, and newlines. Terminal control sequences that
  // are not parsed SGR styles must never reach the DOM.
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

function indexedColor(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) { return undefined; }
  if (index < 16) { return ANSI_COLORS[index]; }
  if (index >= 232) {
    const value = 8 + (index - 232) * 10;
    return `rgb(${value}, ${value}, ${value})`;
  }
  const value = index - 16;
  const levels = [0, 95, 135, 175, 215, 255];
  const red = levels[Math.floor(value / 36) % 6];
  const green = levels[Math.floor(value / 6) % 6];
  const blue = levels[value % 6];
  return `rgb(${red}, ${green}, ${blue})`;
}

function applyExtendedColor(
  codes: number[],
  index: number,
): { color?: string; consumed: number } {
  const mode = codes[index + 1];
  if (mode === 5) {
    return { color: indexedColor(codes[index + 2]), consumed: 2 };
  }
  if (mode === 2) {
    const channels = codes.slice(index + 2, index + 5);
    if (channels.length === 3 && channels.every((channel) => channel >= 0 && channel <= 255)) {
      return { color: `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`, consumed: 4 };
    }
  }
  return { consumed: 0 };
}

function applyCodes(style: AnsiStyle, codes: number[]): AnsiStyle {
  let next = cloneStyle(style);
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index];
    if (code === 0) { next = {}; }
    else if (code === 1) { next.bold = true; }
    else if (code === 2) { next.dim = true; }
    else if (code === 3) { next.italic = true; }
    else if (code === 4) { next.underline = true; }
    else if (code === 7) { next.inverse = true; }
    else if (code === 9) { next.strikethrough = true; }
    else if (code === 22) { delete next.bold; delete next.dim; }
    else if (code === 23) { delete next.italic; }
    else if (code === 24) { delete next.underline; }
    else if (code === 27) { delete next.inverse; }
    else if (code === 29) { delete next.strikethrough; }
    else if (code >= 30 && code <= 37) { next.foreground = ANSI_COLORS[code - 30]; }
    else if (code === 38 || code === 48) {
      const extended = applyExtendedColor(codes, index);
      if (extended.color) {
        if (code === 38) { next.foreground = extended.color; }
        else { next.background = extended.color; }
      }
      index += extended.consumed;
    }
    else if (code === 39) { delete next.foreground; }
    else if (code >= 40 && code <= 47) { next.background = ANSI_COLORS[code - 40]; }
    else if (code === 49) { delete next.background; }
    else if (code >= 90 && code <= 97) { next.foreground = ANSI_COLORS[code - 90 + 8]; }
    else if (code >= 100 && code <= 107) { next.background = ANSI_COLORS[code - 100 + 8]; }
  }
  return next;
}

/** Parse ANSI SGR sequences while discarding every other terminal control. */
export function parseAnsi(text: string): AnsiSegment[] {
  const terminalControl = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;
  const input = text.replace(
    terminalControl,
    (sequence) => /^\x1b\[[0-9;]*m$/.test(sequence) ? sequence : "",
  );
  const segments: AnsiSegment[] = [];
  const sgr = /\x1b\[([0-9;]*)m/g;
  let style: AnsiStyle = {};
  let cursor = 0;
  let match: RegExpExecArray | null;

  const append = (value: string): void => {
    const safe = sanitizeText(value);
    if (safe) { segments.push({ text: safe, style: cloneStyle(style) }); }
  };

  while ((match = sgr.exec(input)) !== null) {
    append(input.slice(cursor, match.index));
    const codes = match[1] === ""
      ? [0]
      : match[1].split(";").map((value) => Number.parseInt(value, 10)).filter(Number.isFinite);
    style = applyCodes(style, codes.length > 0 ? codes : [0]);
    cursor = sgr.lastIndex;
  }
  append(input.slice(cursor));
  return segments;
}
