// ── highlight.js setup ─────────────────────────────────────
// Tree-shakeable: only the languages we register are bundled.

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml"; // covers html, xml, svg
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

// Aliases
hljs.registerAliases(["js", "jsx", "mjs", "cjs"], { languageName: "javascript" });
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["py", "py3"], { languageName: "python" });
hljs.registerAliases(["rs"], { languageName: "rust" });
hljs.registerAliases(["sh", "shell", "zsh"], { languageName: "bash" });
hljs.registerAliases(["html", "htm", "svg"], { languageName: "xml" });
hljs.registerAliases(["scss", "less"], { languageName: "css" });
hljs.registerAliases(["yml"], { languageName: "yaml" });
hljs.registerAliases(["md", "mdx"], { languageName: "markdown" });
hljs.registerAliases(["golang"], { languageName: "go" });
hljs.registerAliases(["yml", "yaml"], { languageName: "yaml" }); // bonus

// Language name normalizer: maps our getLangFromPath results to hljs names.
const langMap: Record<string, string | undefined> = {
  javascript: "javascript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  typescript: "typescript",
  ts: "typescript",
  tsx: "typescript",
  python: "python",
  py: "python",
  py3: "python",
  rust: "rust",
  rs: "rust",
  go: "go",
  golang: "go",
  java: "java",
  bash: "bash",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  json: "json",
  xml: "xml",
  html: "xml",
  htm: "xml",
  svg: "xml",
  css: "css",
  scss: "css",
  less: "css",
  markdown: "markdown",
  md: "markdown",
  mdx: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: undefined,
  dockerfile: undefined,
  makefile: undefined,
  sql: undefined,
  php: undefined,
  rb: undefined,
  swift: undefined,
  kt: undefined,
  lua: undefined,
  r: undefined,
  scala: undefined,
  hs: undefined,
  ex: undefined,
  exs: undefined,
  erl: undefined,
  proto: undefined,
  graphql: undefined,
  tf: undefined,
  hcl: undefined,
  ps1: undefined,
  c: undefined,
  cpp: undefined,
  cs: undefined,
};

/**
 * Highlight code and return safe HTML.
 * `lang` is our getLangFromPath result (e.g. "javascript", "js", "py").
 * Falls back to escaped plain text for unsupported languages.
 */
export function highlightCode(code: string, lang: string): string {
  const hljsLang = langMap[lang];
  if (!hljsLang) {
    return escapeHtml(code);
  }
  try {
    const result = hljs.highlight(code, { language: hljsLang });
    return result.value;
  } catch (e) {
    // If highlighting fails (e.g. illegal syntax), return escaped text
    console.warn("[pi-gui] highlightCode failed for lang=" + lang + ":", e);
    return escapeHtml(code);
  }
}

/** Escape HTML-special characters (shared implementation — escapes quotes too). */
import { escapeHtml } from "../shared/escape-html.js";
