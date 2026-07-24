import { state } from "../state.js";
import { logEvent } from "../debug.js";
import {
  createToolBlock, morphRender, escapeHtml, renderToolResult,
  renderFileContent, renderDiffMarkup, renderDiffIfApplicable,
  formatToolError, getLangFromPath, getCompactReadLabel,
  renderMarkdown, renderMarkdownSafe, hideWelcome, scrollToBottom, renderToolResultTruncated,
  registerToolRenderer, getToolRenderer, truncate,
} from "../render/engine.js";
import { highlightCode } from "../highlight.js";
import { html, safe } from "../render/html.js";
import { ToolBlock } from "../components/tool-block.js";

// ── Tool data shapes ─────────────────────────────────────────
type ToolData = Record<string, unknown> & {
  toolCallId: string;
  toolName: string;
  entryId?: string;
  args?: Record<string, unknown>;
  fromMessage?: boolean;
};
type ToolPartialResult = { content?: Array<{ type: string; text: string }> };
type ToolResult = {
  content?: Array<{ type: string; text: string }>;
  details?: Record<string, unknown>;
  text?: string;
};
type ToolEl = HTMLElement;
import { CodeBlock } from "../components/code-block.js";





  // ═══ Write Tool Renderer ══════════════════════════════════
  //
  // Shows file content inline with syntax highlighting as the
  // model streams the write call.  The result area only shows
  // error output (matching the pi TUI behaviour).

export const writeToolRenderer = {
    create: function (data: ToolData): ToolEl {
      hideWelcome();
      var rawPath = data.args && (data.args.path || data.args.file_path || data.args.filePath);
      var fileContent = data.args && data.args.content;
      var lang = rawPath ? getLangFromPath(rawPath as string) : undefined;

      var tb = new ToolBlock({
        toolName: "write",
        toolCallId: data.toolCallId,
        entryId: data.entryId,
        filePath: (rawPath as string) || undefined,
        status: "running",
      });
      var block = tb.el as unknown as ToolEl;
      (block as any)._toolBlock = tb; // attach component for update/finalize
      (block as any)._writeState = { lang: lang, content: "", rawPath: rawPath };

      if (typeof fileContent === "string" && fileContent) {
        (block as any)._writeState!.content = fileContent;
        renderWriteContentBlock(block);
      }

      return block;
    },
    update: function (el: ToolEl, partialResult: ToolPartialResult) {
      if (!partialResult || !partialResult.content) {return;}
      var text = partialResult.content
        .filter(function (c: { type: string; text: string }) { return c.type === "text"; })
        .map(function (c: { type: string; text: string }) { return c.text; })
        .join("\n");
      if (!text) {return;}

      // rAF-batched: accumulate latest args JSON, flush once per frame.
      // Prevents bursty re-renders when write-tool args stream token by token.
      (el as any)._writePending = text;
      if (!(el as any)._writeRafId) {
        (el as any)._writeRafId = requestAnimationFrame(function () {
          (el as any)._writeRafId = null;
          if ((el as any)._writePending) {
            processWriteUpdate(el, (el as any)._writePending);
            (el as any)._writePending = null;
          }
        });
      }
    },
    finalize: function (el: ToolEl, result: ToolResult, isError: boolean, entryId?: string) {
      // Flush any pending rAF render
      if ((el as any)._writeRafId) { cancelAnimationFrame((el as any)._writeRafId); (el as any)._writeRafId = null; }
      if ((el as any)._writePending) { processWriteUpdate(el, (el as any)._writePending); (el as any)._writePending = null; }

      var tb = (el as any)._toolBlock;
      if (tb) {
        (tb as any).update({ status: isError ? "error" : "done", entryId: entryId });
      } else {
        var statusEl = el.querySelector(".tool-status");
        if (statusEl) {
          statusEl.textContent = isError ? "error" : "done";
          statusEl.className = "tool-status " + (isError ? "error" : "success");
        }
        el.setAttribute("data-status", isError ? "error" : "done");
        if (entryId && !el.id.startsWith("entry-")) {
          el.id = "entry-" + entryId;
        }
      }

      // Re-render final content, scroll to top
      renderWriteContentBlock(el);
      var sv = el.querySelector(".tool-scroll-view");
      if (sv) { sv.scrollTop = 0; }

      // Only show error output (matching TUI: result hidden on success)
      if (isError && result && result.content) {
        var errorText = result.content
          .filter(function (c: { type: string; text: string }) { return c.type === "text"; })
          .map(function (c: { type: string; text: string }) { return c.text; })
          .join("\n");
        var tr = tb ? (tb as any).getResultEl() : el.querySelector(".tool-result");
        if (tr && errorText) {
          tr.innerHTML = html`<div style="color:var(--vscode-errorForeground);margin-top:6px;white-space:pre-wrap;font-size:0.85em;">${formatToolError(errorText, "write")}</div>`;
        }
      }
    },
  };

  /** Process a write tool update from streaming JSON args. */
export function processWriteUpdate(el: ToolEl, text: string) {
    try {
      var args = JSON.parse(text);
      if (args.content && typeof args.content === "string") {
        (el as any)._writeState.content = args.content;
        renderWriteContentBlock(el);
      }
      if (args.path) {
        (el as any)._writeState!.rawPath = args.path;
        (el as any)._writeState.lang = getLangFromPath(args.path);
        var pathEl = el.querySelector(".tool-path");
        if (pathEl) {pathEl.textContent = args.path;}
      }
    } catch (e) {
      // JSON incomplete (mid-stream) — try heuristic extraction of content.
      // Expected during streaming; only log if it persists (not a real error).
      var match = text.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (match) {
        (el as any)._writeState!.content = match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\t/g, "\t");
        renderWriteContentBlock(el);
      }
    }
  }

  /** Update the .tool-content area of a write block with highlighted file content. */
export function renderWriteContentBlock(el: ToolEl) {
    var tc = el.querySelector(".tool-content");
    if (!tc) {return;}
    var writeState: any = (el as any)._writeState || {};
    var content = writeState.content || "";
    var lang = writeState.lang;
    var active = el.getAttribute("data-status") !== "done" && el.getAttribute("data-status") !== "error";

    // Fixed-size scrollable container — same height active and done.
    // The code block is rendered at full natural height inside a scroll-view
    // that caps the visible area.  Auto-scrolls to bottom during streaming.
    var scrollView = tc!.querySelector(".tool-scroll-view");
    if (!scrollView) {
      tc.innerHTML = '<div class="tool-scroll-view" style="max-height:15rem;overflow-y:auto;"></div>';
      scrollView = tc.querySelector(".tool-scroll-view");
      var cbComp = new CodeBlock({ code: content, lang: lang, showHeader: true, showCopy: true });
      cbComp.mount(scrollView!);
    } else {
      // Persist the .code-block so scroll state survives across renders
      var cb = scrollView!.querySelector(".code-block");
      if (!cb) {
        scrollView.innerHTML = "";
        var newCb = new CodeBlock({ code: content, lang: lang, showHeader: true, showCopy: true });
        newCb.mount(scrollView);
      } else {
        var tmp = document.createElement("div");
        var tmpCb = new CodeBlock({ code: content, lang: lang, showHeader: true, showCopy: true });
        tmp.appendChild(tmpCb.el);
        var freshCode = tmp.querySelector(".code-block code");
        var existingCode = cb.querySelector("code");
        if (freshCode && existingCode) {
          existingCode.innerHTML = freshCode.innerHTML;
        }
      }
    }

    if (active) {
      scrollView!.scrollTop = scrollView!.scrollHeight;
    }
  }

  // ═══ Edit Tool Renderer ══════════════════════════════════
  //
  // Shows each edit as a mini-diff with word-level change
  // highlighting in the call block.  The result area shows the
  // actual computed diff when execution finishes.

  /** Normalize edit args to the standard { path, edits } shape.
   *  Mirrors the Pi SDK's prepareEditArguments: some models send
   *  oldText/newText as top-level fields instead of inside an
   *  edits[] array, and some send edits as a JSON string. */
  function normalizeEditArgs(args: any): any[] | undefined {
    if (!args) { return undefined; }
    // Parse string-style edits (some models send edits as JSON text)
    if (typeof args.edits === "string") {
      try { args.edits = JSON.parse(args.edits); } catch (_e) { /* ignore */ }
    }
    // Legacy format: oldText/newText as top-level fields
    if (typeof args.oldText === "string" && typeof args.newText === "string") {
      var edits = Array.isArray(args.edits) ? args.edits.slice() : [];
      edits.push({ oldText: args.oldText, newText: args.newText });
      return edits;
    }
    return args.edits;
  }

export const editToolRenderer = {
    create: function (data: ToolData) {
      hideWelcome();
      var rawPath = data.args && (data.args.path || data.args.file_path || data.args.filePath);
      var edits = normalizeEditArgs(data.args);
      var editCount = Array.isArray(edits) ? edits.length : 0;
      var editLabel = editCount > 1 ? " (" + editCount + " edits)" : "";

      var tb = new ToolBlock({
        toolName: "edit",
        toolCallId: data.toolCallId,
        entryId: data.entryId,
        filePath: (rawPath as string) || undefined,
        status: "running",
        pathExtra: editLabel,
      });
      var block = tb.el as unknown as ToolEl;
      (block as any)._toolBlock = tb;

      if (Array.isArray(edits) && edits.length > 0) {
        block._editEdits = edits;
        block._editLang = rawPath ? getLangFromPath(rawPath as string) : undefined;
        renderEditPreviews(block, edits);
      }

      return block;
    },
    update: function (el: ToolEl, partialResult: ToolPartialResult) {
      if (!partialResult || !partialResult.content) {return;}
      var text = partialResult.content
        .filter(function (c: { type: string; text: string }) { return c.type === "text"; })
        .map(function (c: { type: string; text: string }) { return c.text; })
        .join("\n");
      if (!text) {return;}

      try {
        var args = JSON.parse(text);
        var edits = normalizeEditArgs(args);
        if (Array.isArray(edits) && edits.length > 0) {
          (el as any)._editEdits = edits;
          // Update edit count in header
          var editLabel = edits.length > 1 ? " (" + edits.length + " edits)" : "";
          var pathEl = el.querySelector(".tool-path");
          if (pathEl) {pathEl.textContent = (args.path || "...") + editLabel;}
          renderEditPreviews(el, edits);
        }
      } catch (e) {
        // JSON incomplete during streaming — expected, not an error
      }
    },
    finalize: function (el: ToolEl, result: ToolResult, isError: boolean, entryId?: string) {
      var tb = (el as any)._toolBlock;
      if (tb) {
        (tb as any).update({ status: isError ? "error" : "done", entryId: entryId });
      } else {
        var statusEl = el.querySelector(".tool-status");
        if (statusEl) {
          statusEl.textContent = isError ? "error" : "done";
          statusEl.className = "tool-status " + (isError ? "error" : "success");
        }
        el.setAttribute("data-status", isError ? "error" : "done");
        if (entryId && !el.id.startsWith("entry-")) {
          el.id = "entry-" + entryId;
        }
      }

      // Re-render previews to collapse to max 3 now that streaming is done
      if ((el as any)._editEdits) { renderEditPreviews(el as any, (el as any)._editEdits); }

      var text = "";
      if (result && result.content) {
        text = result.content
          .filter(function (c: { type: string; text: string }) { return c.type === "text"; })
          .map(function (c: { type: string; text: string }) { return c.text; })
          .join("\n");
      }
      // The Pi SDK's edit tool returns the diff in result.details.diff,
      // not in the content text.  Only render it in the result area when
      // previews weren't shown (no _editEdits).  When previews were rendered,
      // they already show the red/green old/new blocks in .tool-content, so
      // duplicating the diff in .tool-result would be redundant (TUI matches
      // this — formatEditResult only returns a diff when it differs from the
      // preview).
      var hasPreviews = !!(el as any)._editEdits;
      var diffText = !hasPreviews ? (result?.details?.diff as string | undefined) : undefined;
      if (diffText) {
        text = text ? text + "\n" + diffText : diffText;
      }
      if (!text && result && typeof result.text === "string") {text = result.text;}
      if (!text && result && typeof result === "string") {text = result;}
      if (!text && result && result.content && result.content.length > 0) {
        try { text = JSON.stringify(result.content, null, 2); } catch (e) { console.warn("[pi-gui] JSON.stringify failed for tool result content"); }
      }

      var tr = el.querySelector(".tool-result");
      if (tr && text) {
        if (isError) {
          tr.innerHTML = html`<div style="color:var(--vscode-errorForeground);white-space:pre-wrap;font-size:0.85em;">${formatToolError(text, "edit")}</div>`;
        } else {
          tr.innerHTML = '<div style="margin-top:4px;">' + renderDiffIfApplicable(text) + '</div>';
        }
      }
    },
  };

  /** Render per-edit mini-diffs into the .tool-content of an edit block. */
export function renderEditPreviews(el: ToolEl, edits: Array<{ oldText: string; newText: string }>) {
    var tc = el.querySelector(".tool-content");
    if (!tc) {return;}
    var active = el.getAttribute("data-status") !== "done" && el.getAttribute("data-status") !== "error";
    var lang = (el as any)._editLang;
    // Build edit previews inline (no surrounding whitespace).
    var result = "";

    for (var i = 0; i < edits.length; i++) {
      var edit = edits[i];
      var oldText = edit.oldText || "";
      var newText = edit.newText || "";
      var editHeader = edits.length > 1
        ? safe(html`<div class="edit-header">Edit ${i + 1} of ${edits.length}</div>`)
        : "";
      result += html`<div class="edit-change">${editHeader}<div class="edit-old">- ${lang ? safe(highlightCode(oldText, lang)) : oldText}</div><div class="edit-new">+ ${lang ? safe(highlightCode(newText, lang)) : newText}</div></div>`;
    }

    // Only use scroll wrapper when there are many edits; otherwise let it grow naturally.
    var needsScroll = edits.length > 3;
    var scrollStyle = needsScroll ? "max-height:15rem;overflow-y:auto;" : "";

    var scrollView = tc!.querySelector(".tool-scroll-view");
    if (!scrollView) {
      tc.innerHTML = html`<div class="tool-scroll-view" style="${scrollStyle}">${safe(result)}</div>`;
      scrollView = tc.querySelector(".tool-scroll-view");
    } else {
      scrollView!.setAttribute("style", scrollStyle);
      scrollView.innerHTML = result;
    }

    if (active && scrollView) {
      scrollView!.scrollTop = scrollView!.scrollHeight;
      requestAnimationFrame(function () {
        var blocks = scrollView!.querySelectorAll(".edit-old, .edit-new");
        for (var b = 0; b < blocks.length; b++) {
          if (blocks[b].scrollHeight > blocks[b].clientHeight) {
            blocks[b].scrollTop = blocks[b].scrollHeight;
          }
        }
      });
    }
  }

  // ═══ Read Tool Renderer ═══════════════════════════════════
  //
  // Shows the file path with optional line range in the header.
  // Results are syntax-highlighted from the file extension with
  // expand / collapse for long content.  Compact labels are used
  // for SKILL.md, AGENTS.md, and other resource files.

export const readToolRenderer = {
    create: function (data: ToolData) {
      hideWelcome();
      var rawPath = data.args && (data.args.path || data.args.file_path || data.args.filePath);
      var offset = data.args && data.args.offset;
      var limit = data.args && data.args.limit;
      var rangeLabel = "";
      if (offset !== undefined) {
        rangeLabel = ":" + (offset as number);
        if (limit !== undefined) {rangeLabel += "-" + ((offset as number) + (limit as number) - 1);}
      }

      var compact = getCompactReadLabel(rawPath as string);

      var tb = new ToolBlock({
        toolName: "read",
        toolCallId: data.toolCallId,
        entryId: data.entryId,
        filePath: (rawPath as string) || undefined,
        status: "running",
        pathExtra: rangeLabel,
      });
      var block = tb.el as unknown as ToolEl;
      (block as any)._toolBlock = tb;

      // Add compact label below header if applicable
      if (compact) {
        var compactEl = document.createElement("div");
        compactEl.className = "compact-label";
        compactEl.textContent = "[" + compact.kind + "] " + compact.label;
        (tb as any).getHeaderEl().after(compactEl);
      }

      // Store path, offset, and language for result rendering
      (block as any)._readState = { rawPath: rawPath, lang: rawPath ? getLangFromPath(rawPath as string) : undefined, compact: compact, offset: offset };

      return block;
    },
    update: function (el: ToolEl, partialResult: ToolPartialResult) {
      // Parse complete args from tool-update or tool_execution_start DEDUP handler
      // and patch the header with offset/limit range when they arrive (they often
      // stream in after the initial tool-start from message_update).
      if (!partialResult || !partialResult.content) {return;}
      var text = partialResult.content
        .filter(function (c: { type: string; text: string }) { return c.type === "text"; })
        .map(function (c: { type: string; text: string }) { return c.text; })
        .join("");
      if (!text) {return;}
      try {
        var args = JSON.parse(text);
        if (args && (args.offset !== undefined || args.limit !== undefined)) {
          var offset = args.offset;
          var limit = args.limit;
          var rangeLabel = "";
          if (offset !== undefined) {
            rangeLabel = ":" + offset;
            if (limit !== undefined) {rangeLabel += "-" + (offset + limit - 1);}
          }
          var tb = (el as any)._toolBlock;
          if (tb) {
            (tb as any).update({ pathExtra: rangeLabel } as any);
          } else {
            var pathEl = el.querySelector(".tool-path");
            if (pathEl && pathEl.textContent) {
              // Append range to existing path text (strip any old range first)
              var base = pathEl.textContent.replace(/:\d+(-\d+)?$/, "");
              pathEl.textContent = base + rangeLabel;
            }
          }
        }
      } catch (_e) {
        // JSON incomplete during streaming — expected, not an error
      }
    },
    finalize: function (el: ToolEl, result: ToolResult, isError: boolean, entryId?: string) {
      var tb = (el as any)._toolBlock;
      if (tb) {
        (tb as any).update({ status: isError ? "error" : "done", entryId: entryId });
      } else {
        var statusEl = el.querySelector(".tool-status");
        if (statusEl) {
          statusEl.textContent = isError ? "error" : "done";
          statusEl.className = "tool-status " + (isError ? "error" : "success");
        }
        el.setAttribute("data-status", isError ? "error" : "done");
        if (entryId && !el.id.startsWith("entry-")) {
          el.id = "entry-" + entryId;
        }
      }

      var text = "";
      if (result && result.content) {
        text = result.content
          .filter(function (c: { type: string; text: string }) { return c.type === "text"; })
          .map(function (c: { type: string; text: string }) { return c.text; })
          .join("\n");
      }

      var tr = tb ? (tb as any).getResultEl() : el.querySelector(".tool-result");
      if (!tr) {return;}

      if (isError) {
        tr.innerHTML = html`<div style="color:var(--vscode-errorForeground);white-space:pre-wrap;font-size:0.85em;">${formatToolError(text, "read")}</div>`;
        return;
      }

      if (!text) {
        tr.innerHTML = '<div style="color:var(--vscode-descriptionForeground);font-size:0.85em;">(empty)</div>';
        return;
      }

      // Check for continuation hints BEFORE stripping SDK footer lines.
      // The SDK has two truncation modes:
      //   1. Hard truncation (50KB/2000 lines): result.details.truncation exists
      //   2. User limit with more content: note is embedded in text, no details
      // Parse both so we can render a clickable "Continue" affordance.
      var userMoreMatch = text.match(/\[(\d+) more lines in file\. Use offset=(\d+) to continue\.\]/);

      // Strip SDK truncation footer lines — they're noise in a scrollable webview.
      text = text.replace(/\n?\[Showing[^\]]*\](?:\n|$)/g, "");
      text = text.replace(/\n?\[Truncated[^\]]*\](?:\n|$)/g, "");
      text = text.replace(/\n?\[\d+ more lines in file[^\]]*\](?:\n|$)/g, "");

      var readState: any = (el as any)._readState || {};
      var lang = readState.lang;

      // Syntax-highlighted code in a scrollable container when tall.
      // No expand/collapse — just native scroll.
      (tr as HTMLElement).style.maxHeight = "20rem";
      (tr as HTMLElement).style.overflowY = "auto";
      tr.innerHTML = "";
      var cb = new CodeBlock({ code: text, lang: lang, showHeader: true, showCopy: true });
      cb.mount(tr);
      // Disable inner scroll on the code block — the tool-result is the
      // scroll container.  Without this, the CSS .tool-result .code-block
      // rule adds a second nested scrollbar.
      var preEl = tr.querySelector(".code-block");
      if (preEl) { preEl.style.maxHeight = "none"; preEl.style.overflowY = "visible"; }

      // If the result was truncated (SDK-enforced or user-limited), add a
      // clickable "Continue reading" link that inserts the follow-up into
      // the input bar (user reviews, then presses Enter).
      var trunc = result && result.details && result.details.truncation;
      var hasMore = false;
      var contNextOffset = 0;
      var contRemaining = 0;

      if (trunc && (trunc as any).truncated) {
        // Case 1: SDK hard truncation (50KB or 2000 lines)
        contNextOffset = (readState.offset || 0) + (trunc as any).outputLines;
        contRemaining = (trunc as any).totalLines - contNextOffset;
        hasMore = contRemaining > 0;
      } else if (userMoreMatch) {
        // Case 2: User-specified limit with more content in file
        contRemaining = parseInt(userMoreMatch[1], 10);
        contNextOffset = parseInt(userMoreMatch[2], 10);
        hasMore = contRemaining > 0;
      }

      if (hasMore) {
        var contEl = document.createElement("div");
        contEl.style.cssText = "margin-top:6px;font-size:0.8em;color:var(--vscode-descriptionForeground);cursor:pointer;text-decoration:underline;";
        contEl.textContent = "\u25BC Continue reading (" + contRemaining + " lines remaining)";
        contEl.addEventListener("click", function () {
          // Insert into the input bar — user reviews and presses Enter.
          // Auto-submitting would create a new agent turn / read block,
          // which is surprising when you expected inline expansion.
          var cmd = "Continue reading " + readState.rawPath + " from offset " + contNextOffset;
          if (state.promptInput) {
            state.promptInput.value = cmd + " ";
            state.promptInput.focus();
            state.promptInput.dispatchEvent(new Event("input"));
          }
        });
        tr.appendChild(contEl);
      }
    },
  };

  // ── Default (generic) tool renderer ──────────────────────
  // ── Default (generic) tool renderer ──────────────────────

export const defaultToolRenderer = {
    create: function (data: ToolData) {
      return createToolBlock(data.toolName, data.toolCallId, "pending", data.args);
    },
    update: function (el: ToolEl, partialResult: ToolPartialResult) {
      var tr = el.querySelector(".tool-result");
      if (!tr || !partialResult || !partialResult.content) {return;}
      var text = partialResult.content
        .filter(function (c: { type: string; text: string }) { return c.type === "text"; })
        .map(function (c: { type: string; text: string }) { return c.text; })
        .join("\n");
      if (!text) {return;}
      var lines = (text as string).split("\n");
      var displayText = lines.length > 60 ? "...\n" + lines.slice(-60).join("\n") : text;
      morphRender(tr, renderToolResult(displayText));
    },
    finalize: function (el: ToolEl, result: ToolResult, isError: boolean, entryId?: string) {
      var statusEl = el.querySelector(".tool-status");
      if (statusEl) {
        statusEl.textContent = isError ? "error" : "done";
        statusEl.className = "tool-status " + (isError ? "error" : "success");
      }
      el.setAttribute("data-status", isError ? "error" : "done");
      if (entryId && !el.id.startsWith("entry-")) {
        el.id = "entry-" + entryId;
      }
      var text = "";
      if (result && result.content) {
        text = result.content
          .filter(function (c: { type: string; text: string }) { return c.type === "text"; })
          .map(function (c: { type: string; text: string }) { return c.text; })
          .join("\n");
      }
      var tr = el.querySelector(".tool-result");
      if (tr) {
        if (isError) {
          var displayText = formatToolError(text as string, (el.querySelector(".tool-name") as HTMLElement) ? (el.querySelector(".tool-name") as HTMLElement).textContent || "" : "");
          tr.innerHTML = html`<div style="color:var(--vscode-errorForeground);white-space:pre-wrap;font-size:0.85em;margin-top:4px;">${displayText}</div>`;
        } else {
          var lines = (text as string).split("\n");
          tr.innerHTML = lines.length > 50 ? renderToolResultTruncated(text) : renderToolResult(text);
        }
      }
    },
  };

  // ── Bash tool renderer ───────────────────────────────────

export const bashToolRenderer = {
    create: function (data: ToolData) {
      hideWelcome();
      var block = document.createElement("div");
      block.className = "bash-execution";
      block.id = data.entryId ? "entry-" + data.entryId : "bash-" + data.toolCallId;
      block.setAttribute("data-tool-call-id", data.toolCallId);
      if (data.entryId) { block.setAttribute("data-entry-id", data.entryId); }
      block.setAttribute("data-status", "running");
      var cmd = (data.args?.command as string) || "";
      if ((cmd as string).length > 120) {cmd = cmd!.slice(0, 120) + "\u2026";}
      block.innerHTML = html`
        <div class="bash-header">$ ${cmd}</div>
        <div class="bash-output"></div>
        <div class="bash-footer"><span class="bash-spinner"></span> <span class="cancel-hint">running\u2026</span></div>`;
      state.bashBlocks[data.toolCallId] = block;
      state.bashOutputs[data.toolCallId] = "";
      return block;
    },
    update: function (el: ToolEl, partialResult: ToolPartialResult) {
      // Only accumulate from bash-output events, not from tool-update.
      // tool-update events contain JSON-serialized args that would
      // leak noise ({}{}{}{}) into the output div.
      // Output is handled exclusively by handleBashOutput.
    },
    finalize: function (el: ToolEl, result: ToolResult, isError: boolean, entryId?: string) {
      var toolCallId = el.id.replace(/^(entry-|bash-)/, "");
      var text = "";
      if (result && result.content) {
        text = result.content
          .filter(function (c: { type: string; text: string }) { return c.type === "text"; })
          .map(function (c: { type: string; text: string }) { return c.text; })
          .join("\n");
      }
      var outEl = el.querySelector(".bash-output");
      if (outEl && text) {morphRender(outEl, escapeHtml(text));}
      var footer = el.querySelector(".bash-footer");
      var details = result && result.details ? result.details : {};
      var exitCode = details.exitCode !== undefined ? details.exitCode : 0;
      if (footer) {
        footer.innerHTML = html`
          <span class="exit-code${isError ? " error" : ""}">exit: ${exitCode}</span>
          ${details.cancelled ? " <span>(cancelled)</span>" : ""}`;
      }
      if (entryId && !el.id.startsWith("entry-")) {
        el.id = "entry-" + entryId;
      }
      el.setAttribute("data-status", isError ? "error" : "complete");
      delete state.bashBlocks[toolCallId];
      delete state.bashOutputs[toolCallId];
    },
  };

  registerToolRenderer("bash", bashToolRenderer);
  registerToolRenderer("write", writeToolRenderer);
  registerToolRenderer("edit", editToolRenderer);
  registerToolRenderer("read", readToolRenderer);

  // ── Tool block insertion helper ────────────────────────
  //
  // Inserts a tool/batch block after the current assistant message
  // so tools render inline with the conversation flow (matching the
  // TUI behaviour) instead of accumulating at the bottom of chatContainer.
  // Falls back to appendChild when there's no assistant anchor (e.g.
  // during initial replay).

  function insertToolBlock(block: HTMLElement) {
    var waitingIndicator = document.getElementById("working-indicator");
    var anchor = state.lastToolInsertionEl || state.currentAssistantEl;
    if (anchor && anchor.parentNode === state.chatContainer) {
      // Insert after anchor
      var next = anchor.nextSibling;
      if (next) {
        state.chatContainer.insertBefore(block, next);
      } else {
        state.chatContainer.appendChild(block);
      }
    } else {
      state.chatContainer.appendChild(block);
    }
    state.lastToolInsertionEl = block;
    // Keep the active Pi status at the bottom, after assistant and tool output.
    if (waitingIndicator && waitingIndicator.parentNode === state.chatContainer) {
      state.chatContainer.appendChild(waitingIndicator);
    }
  }

  // Exported for handleBashStart in handlers/index.ts
  export { insertToolBlock };

  // ═══ Message Renderer Registry ════════════════════════════
  // ═══ Tool Lifecycle ════════════════════════════════════

export function handleToolStart(data: any) {
    hideWelcome();

    // Stop thinking spinner — tool execution means thinking is done
    if (state.currentThinkingEl) {
      var _tb = state.currentThinkingEl._component;
      if (_tb) {
        (_tb as any).update({ content: (_tb as any)._rawText || "", done: true });
      } else {
        var thSpinner = state.currentThinkingEl.querySelector(".thinking-spinner");
        if (thSpinner) {thSpinner.remove();}
      }
    }

    var callId = data.toolCallId;
    logEvent("tool-start", {
      callId: callId,
      toolName: data.toolName,
      entryId: data.entryId,
      fromMessage: data.fromMessage,
      inToolBlocks: !!state.currentToolBlocks[callId],
      inBashBlocks: !!state.bashBlocks[callId],
    });

    // Guard against duplicates — check BOTH trackers (#fix: bash blocks
    // created by handleBashStart were invisible to this dedup, causing
    // orphaned duplicate DOM nodes that never finalize).
    var existingTool = state.currentToolBlocks[callId];
    var existingBash = state.bashBlocks[callId];

    if (existingTool || existingBash) {
      logEvent("tool-start:DEDUP", {
        callId: callId,
        inTool: !!existingTool,
        inBash: !!existingBash,
        bashStatus: existingBash ? (existingBash.getAttribute ? existingBash.getAttribute("data-status") : "?") : "N/A",
      });
      // If we have a bash block, promote it into currentToolBlocks so the
      // tool-end handler can finalize it through the normal path.
      if (existingBash && !existingTool) {
        state.currentToolBlocks[callId] = { el: existingBash, renderer: bashToolRenderer };
      }
      // Update status on whichever block we have
      var block = existingTool ? ((existingTool as any).el || existingTool) : existingBash;
      if (block && block.getAttribute && block.getAttribute("data-status") === "pending") {
        block.setAttribute("data-status", "running");
        var statusEl = block.querySelector(".tool-status");
        if (statusEl) {
          statusEl.textContent = "running";
          statusEl.className = "tool-status running";
        }
      }
      // If the new data has a path but the existing block shows "...", update it
      var newPath = data.args && (data.args.path || data.args.file_path || data.args.filePath);
      if (newPath && block) {
        var pathEl = block.querySelector(".tool-path");
        if (pathEl && pathEl.textContent === "...") {
          pathEl.textContent = newPath;
          pathEl.setAttribute("data-path", newPath);
        }
        // Also update internal state so lang/syntax highlighting work
        if ((block as any)._readState && !(block as any)._readState!.rawPath) {
          (block as any)._readState!.rawPath = newPath;
          (block as any)._readState!.lang = getLangFromPath(newPath);
        }
        if ((block as any)._writeState && !(block as any)._writeState!.rawPath) {
          (block as any)._writeState!.rawPath = newPath;
          (block as any)._writeState!.lang = getLangFromPath(newPath);
        }
        // Update ToolBlock component if present
        var tb = (block as any)._toolBlock;
        if (tb) { (tb as any).update({ filePath: newPath }); }
      }
      // When tool_execution_start fires (fromMessage=false), it carries
      // the complete tool arguments — the first tool-start from
      // message_update often had only partial args.  Feed the complete
      // args to the renderer so it can finish its display (e.g. edit
      // previews that were missing because oldText/newText hadn't
      // arrived yet during streaming).
      if (!data.fromMessage) {
        var dedupRenderer = existingTool ? (existingTool as any).renderer : bashToolRenderer;
        if (dedupRenderer && (dedupRenderer as any).update && data.args) {
          (dedupRenderer as any).update(block, {
            content: [{ type: "text", text: JSON.stringify(data.args, null, 2) }],
          });
        }
        // Also repair the inline args display (tool-args <code>) if it
        // was rendered from incomplete streaming data.
        var argsEl = block?.querySelector?.(".tool-args");
        if (argsEl && data.args) {
          var codeEl = argsEl.querySelector("code");
          if (codeEl) {
            try {
              codeEl.textContent = truncate(JSON.stringify(data.args, null, 2), 200);
            } catch (_e) { /* ignore stringify errors */ }
          }
        }
      }

      if (data.entryId && block && block.id && !block.id.startsWith("entry-")) {
        block.id = "entry-" + data.entryId;
      }
      return;
    }

    // Look up the renderer for this tool name.
    // Fall back to defaultToolRenderer for unregistered tools (e.g. extension tools).
    var renderer = getToolRenderer(data.toolName) || defaultToolRenderer;
    var block = (renderer as any).create(data);
    if (!block) { console.warn("[pi-gui] tool renderer returned null for", data.toolName); return; }

    if (data.entryId && !block.id.startsWith("entry-")) {
      block.id = "entry-" + data.entryId;
    }
    insertToolBlock(block);

    // Store both the element and its renderer for update/finalize
    state.currentToolBlocks[callId] = { el: block, renderer: renderer };

    // If fromMessage=false (actual execution), mark as running
    if (!data.fromMessage && renderer === defaultToolRenderer) {
      var statusEl2 = block.querySelector(".tool-status");
      if (statusEl2) {
        statusEl2.textContent = "running";
        statusEl2.className = "tool-status running";
      }
      block.setAttribute("data-status", "running");
    }
    scrollToBottom();
  }

export function handleToolUpdate(data: any) {
    // Ensure thinking spinner stays hidden during tool execution
    if (state.currentThinkingEl) {
      var _tb2 = state.currentThinkingEl._component;
      if (_tb2) {
        (_tb2 as any).update({ content: (_tb2 as any)._rawText || "", done: true });
      } else {
        var thSpinner = state.currentThinkingEl.querySelector(".thinking-spinner");
        if (thSpinner) {thSpinner.remove();}
      }
    }

    var entry = state.currentToolBlocks[data.toolCallId];
    if (!entry) {return;}
    var block = (entry as any).el || entry;
    var renderer = (entry as any).renderer || defaultToolRenderer;
    (renderer as any).update(block, data.partialResult);
    scrollToBottom();
  }

export function handleToolEnd(data: any) {
    var callId = data.toolCallId;
    var entry = state.currentToolBlocks[callId];
    logEvent("tool-end", {
      callId: callId,
      found: !!entry,
      isError: !!data.isError,
      inBashBlocks: !!state.bashBlocks[callId],
      entryId: data.entryId,
    });
    if (!entry) {
      // Fallback: check bashBlocks for blocks created via the legacy path
      var bashBlock = state.bashBlocks[callId];
      if (bashBlock) {
        logEvent("tool-end:FALLBACK-BASH", { callId: callId });
        bashToolRenderer.finalize(bashBlock, data.result, data.isError, data.entryId);
        delete state.bashBlocks[callId];
        delete state.bashOutputs[callId];
        return;
      }
      // Second fallback: find block by DOM ID (tool-{callId} or entry-{entryId})
      var domBlock = document.getElementById("tool-" + callId) || (data.entryId ? document.getElementById("entry-" + data.entryId) : null);
      if (domBlock) {
        logEvent("tool-end:FALLBACK-DOM", { callId: callId, tag: domBlock.tagName, classes: domBlock.className });
        // Use defaultToolRenderer to finalize
        defaultToolRenderer.finalize(domBlock, data.result, data.isError, data.entryId);
      }
      return;
    }
    var block = (entry as any).el || entry;
    var renderer = (entry as any).renderer || defaultToolRenderer;
    (renderer as any).finalize(block, data.result, data.isError, data.entryId);
    delete state.currentToolBlocks[callId];
    scrollToBottom();
  }

  // ═══ Session Events ════════════════════════════════════

  