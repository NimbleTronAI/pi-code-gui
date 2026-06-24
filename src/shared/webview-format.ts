// Pure, DOM-free text/format helpers used by the webview renderer. They live in
// src/shared/ (not src/webview/) for a BUILD reason: src/shared is the one source
// dir compiled by BOTH the extension's tsconfig (so these can be unit-tested
// headlessly via out/) AND the webview's tsconfig + esbuild bundle. The renderer
// (engine.ts) re-exports them, so existing import sites are unchanged. Keep this
// file DOM-free — no `document`, `window`, or html.ts imports.

/** Compact a token count: "0", "850", "1.2k", "34k", "1.5M". */
export function formatTokens(count: number): string {
  if (!count || count === 0) {return "0";}
  if (count < 1000) {return count.toString();}
  if (count < 10000) {return (count / 1000).toFixed(1) + "k";}
  if (count < 100000) {return Math.round(count / 1000) + "k";}
  if (count < 1000000) {return (count / 1000000).toFixed(1) + "M";}
  return Math.round(count / 1000000) + "M";
}

/** Map a file path's extension to a highlight.js language id, or undefined. */
export function getLangFromPath(filePath: string): string | undefined {
  if (!filePath) {return undefined;}
  const ext = filePath.split(".").pop()!.toLowerCase();
  const extToLang: Record<string, string> = {
    ts: "typescript", tsx: "typescript",
    js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
    py: "python", rs: "rust", go: "go", java: "java",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
    cs: "csharp", sh: "bash", bash: "bash", zsh: "bash",
    html: "html", htm: "html", css: "css", scss: "scss", less: "less",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
    xml: "xml", svg: "svg", md: "markdown", markdown: "markdown",
    sql: "sql", php: "php", rb: "ruby", swift: "swift",
    kt: "kotlin", lua: "lua", r: "r", scala: "scala",
    hs: "haskell", ex: "elixir", exs: "elixir", erl: "erlang",
    dockerfile: "dockerfile", makefile: "makefile",
    proto: "protobuf", graphql: "graphql",
    tf: "hcl", hcl: "hcl", ps1: "powershell",
  };
  return extToLang[ext];
}

/** Classify a read of a "resource" file (SKILL.md / AGENTS.md / docs) for a
 *  compact label, or undefined for an ordinary file. */
export function getCompactReadLabel(filePath: string): { kind: string; label: string } | undefined {
  if (!filePath) {return undefined;}
  const name = filePath.split("/").pop() || filePath;
  if (name === "SKILL.md") {
    const parts = filePath.split("/");
    const parent = parts.length >= 2 ? parts[parts.length - 2] : name;
    return { kind: "skill", label: parent };
  }
  if (name === "AGENTS.md" || name === "AGENTS.MD" || name === "CLAUDE.md" || name === "CLAUDE.MD") {
    return { kind: "resource", label: filePath };
  }
  if (name === "README.md" || filePath.indexOf("docs/") !== -1 || filePath.indexOf("examples/") !== -1) {
    return { kind: "docs", label: filePath };
  }
  return undefined;
}

/** Turn a raw tool-error string into a friendly one-liner; passes text through
 *  unchanged when no known pattern matches. `toolName` is reserved for future
 *  per-tool messages. */
export function formatToolError(text: string, _toolName: string): string {
  if (!text) {return text;}
  if (text.indexOf("Validation failed for tool") !== -1) {
    const issues = [];
    const missingRe = /must have required propert(?:y|ies) (\w+)/g;
    let match;
    while ((match = missingRe.exec(text)) !== null) {
      issues.push("missing “" + match[1] + "”");
    }
    const extraRe = /must not have additional propert(?:y|ies)/g;
    if (extraRe.test(text)) {
      const extraMatch = text.match(/additional properties.*?(\w+)/g);
      if (!extraMatch) {issues.push("unexpected field(s)");}
    }
    const hint = issues.length > 0 ? " (" + issues.join(", ") + ")" : "";
    return "⚠ Argument structure mismatch" + hint + " — the agent will self-correct.";
  }
  if (/abort|aborted|cancell?ed/i.test(text)) {
    return "✗ Operation cancelled.";
  }
  if (/permission denied|EACCES|not permitted/i.test(text)) {
    return "⛔ Permission denied — cannot access the file.";
  }
  if (/no such file|ENOENT|not found/i.test(text) && text.indexOf("Validation") === -1) {
    return "🔍 File not found — check the path.";
  }
  if (/timed?\s*out/i.test(text)) {
    return "⏰ Command timed out.";
  }
  return text;
}
