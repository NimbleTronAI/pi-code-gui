// ── Rendering engine ───────────────────────────────────────
//
// All markdown rendering, syntax highlighting, diff viewing,
// code blocks, and UI helper functions extracted from core.js.
//
// Internal helpers (syntax highlighters, parseDiffLine, etc.)
// stay private; only the public API is exported.

import { state, type AppState } from "../state.js";
import { logEvent, logDom } from "../debug.js";
import { highlightCode } from "../highlight.js";
import { html, safe } from "./html.js";
import { renderInlineTokens, type MarkdownTokens } from "./markdown-inline.js";
import { CodeBlock } from "../components/code-block.js";
import { ThinkingBlock } from "../components/thinking-block.js";
import { shouldShowFollowUpHint } from "./waiting-indicator.js";
import { scheduleFollowScroll } from "./scroll-lock.js";

// ═══ Utilities ══════════════════════════════════════════════

export function formatTokens(count: number): string {
  if (!count || count === 0) {return "0";}
  if (count < 1000) {return count.toString();}
  if (count < 10000) {return (count / 1000).toFixed(1) + "k";}
  if (count < 100000) {return Math.round(count / 1000) + "k";}
  if (count < 1000000) {return (count / 1000000).toFixed(1) + "M";}
  return Math.round(count / 1000000) + "M";
}

export function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

export function truncate(text: string, maxLen: number): string {
  if (!text || text.length <= maxLen) {return text || "";}
  return text.substring(0, maxLen) + "...";
}

export function shortenPath(filePath: string): string {
  if (!filePath) {return "";}
  return filePath;
}

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

export function formatToolError(text: string, toolName: string): string {
  if (!text) {return text;}
  if (text.indexOf("Validation failed for tool") !== -1) {
    const issues = [];
    const missingRe = /must have required propert(?:y|ies) (\w+)/g;
    let match;
    while ((match = missingRe.exec(text)) !== null) {
      issues.push("missing \u201C" + match[1] + "\u201D");
    }
    const extraRe = /must not have additional propert(?:y|ies)/g;
    if (extraRe.test(text)) {
      const extraMatch = text.match(/additional properties.*?(\w+)/g);
      if (!extraMatch) {issues.push("unexpected field(s)");}
    }
    const hint = issues.length > 0 ? " (" + issues.join(", ") + ")" : "";
    return "\u26A0 Argument structure mismatch" + hint + " \u2014 the agent will self-correct.";
  }
  if (/abort|aborted|cancell?ed/i.test(text)) {
    return "\u2717 Operation cancelled.";
  }
  if (/permission denied|EACCES|not permitted/i.test(text)) {
    return "\u26D4 Permission denied \u2014 cannot access the file.";
  }
  if (/no such file|ENOENT|not found/i.test(text) && text.indexOf("Validation") === -1) {
    return "\uD83D\uDD0D File not found \u2014 check the path.";
  }
  if (/timed?\s*out/i.test(text)) {
    return "\u23F0 Command timed out.";
  }
  return text;
}

// ═══ Tool Renderer Registry ═════════════════════════════════

export function registerToolRenderer(toolName: string, renderer: unknown): void {
  state.toolRenderers[toolName] = renderer as AppState['toolRenderers'][string];
}

export function getToolRenderer(toolName: string): AppState['toolRenderers'][string] | null {
  return state.toolRenderers[toolName] || null;
}

// ═══ DOM Helpers ═══════════════════════════════════════════

export function morphRender(el: HTMLElement, html: string): void {
  if (!el || html === undefined || html === null) {return;}
  const temp = document.createElement("div");
  temp.innerHTML = html;
  (window as unknown as { morphdom: typeof morphdom }).morphdom(el, temp, { childrenOnly: true });
}

export function createMessageEl(role: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "message " + role;
  el.innerHTML = '<div class="message-content"></div>';
  return el;
}

export function createThinkingBlock(content: string): HTMLElement {
  const tb = new ThinkingBlock({ content: content || "" });
  (tb.el as HTMLElement & { _component?: unknown })._component = tb;
  return tb.el;
}

export function createToolBlock(toolName: string, toolCallId: string, status: string, args?: Record<string, unknown>): HTMLElement {
  const block = document.createElement("div");
  block.className = "tool-block";
  block.id = "tool-" + toolCallId;
  block.setAttribute("data-status", status || "pending");

  let argsText = "";
  if (args) {
    try {
      argsText = JSON.stringify(args, null, 2);
    } catch (e) {
      console.warn("[pi-on-code] JSON.stringify failed for tool args:", e);
      argsText = String(args);
    }
  }

  const isRunning = status === "running";
  block.innerHTML = html`
    <div class="tool-header">
      <span class="tool-name">${toolName}</span>
      <span class="tool-status ${isRunning ? "running" : "pending"}">
        ${isRunning ? "running" : "pending"}
      </span>
    </div>
    ${argsText ? safe(html`<div class="tool-args"><code>${truncate(argsText, 200)}</code></div>`) : ""}
    <div class="tool-result"></div>`;

  return block;
}

export function hideWelcome() {
  if (state._inBatch) {return;}
  if (state.welcome) {
    state.welcome.remove();
    state.welcome = null;
  }
}

export function resetChat() {
  logEvent("resetChat", {
    bashBlocksN: Object.keys(state.bashBlocks).length,
    toolBlocksN: Object.keys(state.currentToolBlocks).length,
  });
  state.chatContainer.innerHTML =
    '<div id="welcome" class="welcome-message"><h2>Pi coding agent</h2></div>';
  state.welcome = document.getElementById("welcome");
  state.currentAssistantEl = null;
  state.currentThinkingEl = null;
  for (const k of Object.keys(state.currentToolBlocks)) {delete state.currentToolBlocks[k];}
  for (const k of Object.keys(state.assistantToolCallIds)) {delete state.assistantToolCallIds[k];}
  state.lastUserMessageContent = null;
  state.isStreaming = false;
  state.isCompacting = false;
  state.isRetrying = false;
  for (const k of Object.keys(state.bashBlocks)) {delete state.bashBlocks[k];}
  for (const k of Object.keys(state.bashOutputs)) {delete state.bashOutputs[k];}
  for (const k of Object.keys(state.truncationTexts)) {delete state.truncationTexts[k];}
  state.truncationIdx = 0;
  state.userMessageHistory.length = 0;
  // These functions are defined in handlers.js but we avoid circular deps
  // by using the global postMessage pattern. See handlers.js for implementation.
  updateStreamingState();
}

export function scrollToBottom(): void {
  scheduleFollowScroll(
    state.chatContainer,
    () => !state.hasScrolledUp,
  );
}

export function updateFollowUpHintVisibility(): void {
  const isWorking = state.isStreaming || state.isCompacting || state.isRetrying;
  state.sbFollowUpHint.hidden = !shouldShowFollowUpHint(isWorking, state.promptInput.value);
}

export function updateStreamingState(): void {
  if (state.isStreaming || state.isCompacting || state.isRetrying) {
    const isFollowUp = state.queueMode === "queue";
    state.sendButton.textContent = isFollowUp ? "Follow-up" : "Steer";
    state.sendButton.title = isFollowUp
      ? "Follow-up (process after current turn)"
      : "Steer (interrupt current request)";
    state.steerDropdown.title = isFollowUp ? "Switch to Steer" : "Switch to Follow-up";
    state.steerDropdown.classList.remove("hidden");
    state.abortButton.classList.remove("hidden");
  } else {
    state.sendButton.textContent = "\u21B5";
    state.sendButton.title = "Submit (Enter)";
    state.steerDropdown.classList.add("hidden");
    state.abortButton.classList.add("hidden");
  }
  updateFollowUpHintVisibility();
}

// ═══ Markdown Rendering ════════════════════════════════════

export function renderMarkdown(text: string): string {
  if (!text) {return "";}
  if (!state._markedAvailable) {
    return escapeHtml(text).replace(/\n/g, "<br>");
  }
  const html = marked.parse(text);
  return postProcessMarkedHTML(html);
}

/** Like renderMarkdown but safe for untrusted content (escapes raw HTML). */
export function renderMarkdownSafe(text: string): string {
  if (!text) {return "";}
  if (!state._markedAvailable) {
    return escapeHtml(text).replace(/\n/g, "<br>");
  }
  // Escape &, <, > so content like "</div>" can't break the container.
  // Order: & first so existing entities aren't re-escaped.
  var safe = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = marked.parse(safe);
  return postProcessMarkedHTML(html);
}

function postProcessMarkedHTML(html: string): string {
  return html.replace(
    /<pre><code(?: class="language-(\w*)")?>([\s\S]*?)<\/code><\/pre>/g,
    function (m: string, lang: string, code: string) {
      const decoded = code
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
      return renderCodeBlockHTML(decoded, lang || "");
    },
  );
}

export function renderCodeBlockHTML(code: string, lang: string): string {
  const cb = new CodeBlock({ code, lang, showHeader: true, showCopy: true });
  return cb.el.outerHTML;
}

export function renderFileContent(content: string, lang: string): string {
  if (!content) {return "";}
  const trimmed = content.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (!trimmed) {return "";}
  const cb = new CodeBlock({ code: trimmed, lang, showHeader: true, showCopy: true });
  return cb.el.outerHTML;
}

// ═══ Block-level Rendering (for structured streaming) ══════

// Token shapes from marked.lexer() — loosely typed because the
// recursive structure makes narrow types mostly boilerplate.
type MarkedToken = Record<string, unknown> & { type: string; raw?: string };
type MarkedTokens = MarkedToken[];

export function renderBlock(token: MarkedToken): Node {
  let el: HTMLElement;
  try {
  switch (token.type) {
    case "heading":
      el = document.createElement("h" + (token.depth as number));
      el.innerHTML = renderInline((token.tokens as MarkedTokens) ?? []);
      return el;
    case "paragraph":
      el = document.createElement("p");
      el.innerHTML = renderInline((token.tokens as MarkedTokens) ?? []);
      return el;
    case "code": {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = renderCodeBlockHTML((token.text as string) || "", (token.lang as string) || "");
      return wrapper.firstChild!;
    }
    case "list":
      el = document.createElement(token.ordered ? "ol" : "ul");
      const items = token.items as Array<{ tokens: MarkedTokens }> | undefined;
      if (items) {
        for (let i = 0; i < items.length; i++) {
          const li = document.createElement("li");
          li.innerHTML = renderInline(items[i].tokens);
          el.appendChild(li);
        }
      }
      return el;
    case "table":
      return renderTableBlock(token);
    case "blockquote":
      el = document.createElement("blockquote");
      const btokens = token.tokens as MarkedTokens | undefined;
      if (btokens) {
        for (let j = 0; j < btokens.length; j++) {
          el.appendChild(renderBlock(btokens[j]!));
        }
      }
      return el;
    case "hr":
      return document.createElement("hr");
    case "space":
      return document.createElement("span");
    default:
      el = document.createElement("div");
      el.textContent = (token.raw as string) || "";
      return el;
  }
  } catch (e) {
    console.warn("[pi-on-code] renderBlock failed for type=" + token.type + ":", e);
    const fallback = document.createElement("div");
    fallback.textContent = (token.raw as string) || "";
    return fallback;
  }
}

function renderTableBlock(token: MarkedToken): HTMLTableElement {
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  const header = token.header as Array<{ tokens: MarkedTokens }>;
  const align = token.align as string[];
  for (let h = 0; h < header.length; h++) {
    const th = document.createElement("th");
    th.style.textAlign = align[h] || "left";
    th.innerHTML = renderInline(header[h].tokens);
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);
  const rows = token.rows as Array<Array<{ tokens: MarkedTokens }>>;
  if (rows.length > 0) {
    const tbody = document.createElement("tbody");
    for (let r = 0; r < rows.length; r++) {
      const tr = document.createElement("tr");
      for (let c = 0; c < rows[r].length; c++) {
        const td = document.createElement("td");
        td.style.textAlign = align[c] || "left";
        td.innerHTML = renderInline(rows[r][c].tokens);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }
  return table;
}

export function renderInline(tokens: MarkedTokens | undefined): string {
  return renderInlineTokens(tokens as MarkdownTokens | undefined, escapeHtml);
}

// ═══ Token-diff Streaming ═════════════════════════════════

/** Diff prev/new token lists and patch the DOM container efficiently. */
export function patchBlockList(container: HTMLElement, prevTokens: unknown[], newTokens: unknown[]): void {
  if (!state._markedAvailable) {
    const raw = container.getAttribute("data-raw") || "";
    morphRender(container, renderMarkdown(raw));
    return;
  }
  while (container.children.length > newTokens.length) {
    container.removeChild(container.lastChild!);
  }
  const commonLen = Math.min(prevTokens.length, newTokens.length);
  for (let i = 0; i < commonLen; i++) {
    const child = container.children[i];
    const prev = prevTokens[i] as Record<string, unknown>;
    const next = newTokens[i] as Record<string, unknown>;
    if (!child) {
      container.appendChild(renderBlock(newTokens[i] as MarkedToken));
    } else if (
      prev.raw !== next.raw ||
      prev.type !== next.type
    ) {
      morphRender(child as HTMLElement, renderBlockToHTML(newTokens[i] as MarkedToken));
    }
  }
  for (let i = prevTokens.length; i < newTokens.length; i++) {
    container.appendChild(renderBlock(newTokens[i] as MarkedToken));
  }
}

export function renderBlockToHTML(token: MarkedToken): string {
  const block = renderBlock(token);
  if (!block) {return "";}
  // Return the element's innerHTML so morphdom can diff children directly.
  // Using outerHTML would cause nesting (the wrapper div from morphRender
  // would match the block's tag, causing .code-block-wrapper > .code-block-wrapper).
  if (block.nodeType === 3 /* TEXT_NODE */) {
    return block.textContent || "";
  }
  return (block as HTMLElement).innerHTML || "";
}

// ═══ Syntax Highlighting ══════════════════════════════════



// ═══ Code Block Handlers ══════════════════════════════════

export function setupCodeBlockHandlers() {
  // ── Click delegation for tool blocks, copy buttons, file paths ──
  state.chatContainer.addEventListener("click", function (e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    // Show-more button for truncated tool results
    const showMoreBtn = target?.closest(".show-more-btn");
    if (showMoreBtn) {
      e.preventDefault();
      const truncEl = showMoreBtn.closest(".tool-result-truncated");
      if (!truncEl) {return;}
      const expanded = truncEl.getAttribute("data-expanded") === "1";
      const id = truncEl.id;
      const stored = state.truncationTexts[id];
      if (!stored) {return;}
      const previewEl = truncEl.querySelector(".tool-result-preview");
      if (!previewEl) {return;}
      if (expanded) {
        previewEl.innerHTML = renderMarkdownSafe(stored.preview);
        truncEl.setAttribute("data-expanded", "0");
        showMoreBtn.textContent =
          "\u25BC " + truncEl.getAttribute("data-hidden") + " more lines";
      } else {
        previewEl.innerHTML = renderMarkdownSafe(stored.full);
        truncEl.setAttribute("data-expanded", "1");
        showMoreBtn.textContent = "\u25B2 Show less";
      }
      return;
    }

    const btn = target?.closest(".code-copy-btn");
    if (!btn) {
      const pathEl = target?.closest(".tool-path") as HTMLElement | null;
      if (pathEl && pathEl.dataset.path) {
        e.preventDefault();
        // Use the global vscode API for file opening
        if (typeof window.__vscode !== "undefined") {
          window.__vscode.postMessage({ type: "openFile", path: pathEl.dataset.path });
        }
      }
      return;
    }
    e.preventDefault();
    const wrapper = btn.closest(".code-block-wrapper");
    if (!wrapper) {return;}
    const pre = wrapper.querySelector(".code-block");
    if (!pre) {return;}
    const text = pre.textContent || "";
    navigator.clipboard.writeText(text).then(
      function () {
        btn.textContent = "Copied!";
        setTimeout(function () { btn.textContent = "Copy"; }, 2000);
      },
      function () {
        btn.textContent = "Failed";
        setTimeout(function () { btn.textContent = "Copy"; }, 2000);
      },
    );
  });
}

// ═══ Diff Rendering ═══════════════════════════════════════

export function renderDiffIfApplicable(text: string): string {
  if (!text) {return renderMarkdown(text);}
  const hasDiff =
    /(?:^|\n)[+\-@]/.test(text) ||
    /(?:^|\n)---\s/.test(text) ||
    /(?:^|\n)\+\+\+\s/.test(text);
  if (!hasDiff) {return renderMarkdown(text);}
  return renderDiffMarkup(text);
}

export function renderDiffMarkup(diffText: string): string {
  const lines = diffText.split("\n");
  const resultLines = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const parsed = parseDiffLine(line);
    if (!parsed) {
      resultLines.push(html`<span class="diff-line-context">${line}</span>`);
      i++;
      continue;
    }
    if (parsed.prefix === "-") {
      const removedLines = [];
      while (i < lines.length) {
        const p2 = parseDiffLine(lines[i]);
        if (!p2 || p2.prefix !== "-") {break;}
        removedLines.push(p2);
        i++;
      }
      const addedLines = [];
      while (i < lines.length) {
        const p3 = parseDiffLine(lines[i]);
        if (!p3 || p3.prefix !== "+") {break;}
        addedLines.push(p3);
        i++;
      }
      if (removedLines.length === 1 && addedLines.length === 1) {
        const intra = diffWords(removedLines[0].content, addedLines[0].content);
        resultLines.push(
          html`<span class="diff-line-removed">-${removedLines[0].lineNum} ${safe(intra.removed)}</span>`,
        );
        resultLines.push(
          html`<span class="diff-line-added">+${addedLines[0].lineNum} ${safe(intra.added)}</span>`,
        );
      } else {
        for (let ri = 0; ri < removedLines.length; ri++) {
          resultLines.push(
            html`<span class="diff-line-removed">-${removedLines[ri].lineNum} ${removedLines[ri].content}</span>`,
          );
        }
        for (let ai = 0; ai < addedLines.length; ai++) {
          resultLines.push(
            html`<span class="diff-line-added">+${addedLines[ai].lineNum} ${addedLines[ai].content}</span>`,
          );
        }
      }
    } else if (parsed.prefix === "+") {
      resultLines.push(
        html`<span class="diff-line-added">+${parsed.lineNum} ${parsed.content}</span>`,
      );
      i++;
    } else {
      resultLines.push(
        html`<span class="diff-line-context"> ${parsed.lineNum} ${parsed.content}</span>`,
      );
      i++;
    }
  }
  return html`<pre style="white-space:pre;font-family:var(--vscode-editor-font-family);font-size:0.85em;line-height:1.55;overflow-x:auto;padding:8px 0;">${safe(resultLines.join("\n"))}</pre>`;
}

function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
  const match = line.match(/^([+\-\s])(\s*\d*)\s(.*)$/);
  if (!match) {return null;}
  return { prefix: match[1]!, lineNum: match[2]!, content: match[3]! };
}

function diffWords(oldStr: string, newStr: string): { removed: string; added: string } {
  const minLen = Math.min(oldStr.length, newStr.length);
  let prefixLen = 0;
  while (prefixLen < minLen && oldStr[prefixLen] === newStr[prefixLen]) {prefixLen++;}
  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    oldStr[oldStr.length - 1 - suffixLen] === newStr[newStr.length - 1 - suffixLen]
  )
    {suffixLen++;}

  const commonPrefix = oldStr.slice(0, prefixLen);
  const commonSuffix = oldStr.slice(oldStr.length - suffixLen);
  const removedMiddle = oldStr.slice(prefixLen, oldStr.length - suffixLen);
  const addedMiddle = newStr.slice(prefixLen, newStr.length - suffixLen);

  return {
    removed: html`${commonPrefix}<span class="diff-word-removed">${removedMiddle}</span>${commonSuffix}`,
    added: html`${commonPrefix}<span class="diff-word-added">${addedMiddle}</span>${commonSuffix}`,
  };
}

// ═══ Tool Result Rendering ════════════════════════════════

/** Render tool result markdown. Detects diffs, code blocks, and JSON. */
export function renderToolResult(text: string): string {
  if (!text) {return "";}
  if (/^```/.test(text.trim())) {
    return renderMarkdown(text);
  }
  if (
    /(?:^|\n)[+\-@]/.test(text) ||
    /(?:^|\n)---\s/.test(text) ||
    /(?:^|\n)\+\+\+\s/.test(text)
  ) {
    return renderDiffMarkup(text);
  }
  const trimmed = text.trim();
  if (trimmed.indexOf("\n") !== -1 || trimmed.length > 120) {
    const lang = detectToolResultLang(trimmed);
    return renderMarkdown("```" + lang + "\n" + trimmed + "\n```");
  }
  // Short untrusted text — escape HTML so it can't break the container.
  return renderMarkdownSafe(text);
}

/** Guess the language of a tool result blob. */
function detectToolResultLang(text: string): string {
  if (/^[\[\{]\s*["\w]/.test(text) && /[\]\}]\s*$/.test(text)) {return "json";}
  if (/<[a-z][\s\S]*>/i.test(text)) {return "html";}
  if (/^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i.test(text)) {return "sql";}
  if (/^[.#]?[\w-]+\s*\{/.test(text)) {return "css";}
  return "";
}

/** Render tool result with "show more" if content exceeds maxLines. */
export function renderToolResultTruncated(text: string, maxLines = 50): string {
  if (!text) {return "";}
  const lines = text.split("\n");
  if (lines.length <= maxLines) {return renderToolResult(text);}

  const previewLines = lines.slice(0, maxLines);
  const hiddenCount = lines.length - maxLines;
  const id = "trunc-" + state.truncationIdx++;

  state.truncationTexts[id] = {
    preview: previewLines.join("\n"),
    full: text,
  };

  return html`
    <div class="tool-result-truncated" id="${id}" data-hidden="${hiddenCount}" data-expanded="0">
      <div class="tool-result-preview">${safe(renderMarkdown(previewLines.join("\n")))}</div>
      <button class="show-more-btn" type="button">\u25BC ${hiddenCount} more lines</button>
    </div>`;
}
