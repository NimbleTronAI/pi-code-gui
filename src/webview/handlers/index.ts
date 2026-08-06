import { state } from "../state.js";
import { logEvent, logDom, summary as debugSummary, debugEventLog } from "../debug.js";
import {
  renderMarkdown, renderBlock, renderInline, patchBlockList,
  escapeHtml, createMessageEl, createThinkingBlock, morphRender,
  truncate, formatTokens, renderToolResult, renderFileContent,
  renderDiffMarkup, formatToolError, getLangFromPath,
  getCompactReadLabel, registerToolRenderer, getToolRenderer,
  hideWelcome, showWelcome, resetChat, scrollToBottom, updateStreamingState,
  updateFollowUpHintVisibility, renderToolResultTruncated, renderBlockToHTML,
  shortenPath, renderCodeBlockHTML,
} from "../render/engine.js";
import { restoreScrollAfterPrepend } from "../render/history-pagination.js";
import { isAllowedMarkdownLink } from "../render/markdown-inline.js";
import { navigateAutocompleteSelection } from "../render/autocomplete-navigation.js";
import {
  filterSlashCommands,
  getSlashCommandFilter,
  renderSlashSourceLabel,
} from "../render/slash-autocomplete.js";
import {
  nextWaitingFrame,
  PI_TUI_SPINNER_FRAMES,
  shouldPlaceWaitingIndicatorAfterMessage,
  shouldPreserveWorkingIndicator,
  shouldShowPromptWaitingIndicator,
} from "../render/waiting-indicator.js";
import { validateExtensionToWebview } from "../../shared/protocol.js";
import { html, safe } from "../render/html.js";
import { LiveCard } from "../components/live-card.js";
import { InlineCard } from "../components/inline-card.js";
import { Dialog, dialogQuestionStem } from "../components/dialog.js";
import { CustomUi } from "../components/custom-ui.js";
import { CONVERSATION_TURNS_EVENT } from "../components/conversation-minimap.js";
import { findWorkspaceFileMention, removeWorkspaceFileMention } from "../file-mention.js";
import {
  handleToolStart, handleToolUpdate, handleToolEnd,
  writeToolRenderer, editToolRenderer, readToolRenderer,
  bashToolRenderer, defaultToolRenderer,
  insertToolBlock, applyAutoToolResultCollapse, addToolOutputCopyButton,
} from "../tools/index.js";




  // ── Send mode when streaming: "steer" (default) or "queue" ──

  // read-write primitives already replaced with state.xxx in body



  // ═══ Message Renderer Registry ════════════════════════════
  //
  // Custom message types (from pi extensions) can register
  // renderers that produce DOM for the live panel.


export function registerMessageRenderer(customType: string, rendererFn: (data: any, container: HTMLElement, ...args: any[]) => void) {
    state.messageRenderers[customType] = rendererFn;
  }

export function getMessageRenderer(customType: string) {
    return state.messageRenderers[customType];
  }

  // Expose for pi extensions to register custom message renderers
  window.__piRegisterMessageRenderer = registerMessageRenderer;

  // Default message renderer: creates a collapsible live-panel card.
  // Each invocation creates a NEW card — notifications and custom messages
  // stack rather than silently replacing each other.
export function defaultMessageRenderer(data: any) {
    var customType = data.customType || "custom";
    var content = "";
    if (typeof data.content === "string") {
      content = data.content;
    } else if (Array.isArray(data.content)) {
      content = data.content
        .filter(function (c: any) { return c.type === "text"; })
        .map(function (c: any) { return c.text; })
        .join("\n");
    }

    var label = customType;
    if (customType === "extension-notify") {
      label = content.split("\n")[0].split("  ")[0].substring(0, 60);
    }
    if (customType === "error") { label = "Error"; }

    // Unique key so cards stack instead of overwriting each other.
    var key = customType + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    return createLiveCard(key, customType, label, content);
  }

  /** Create a collapsible live-panel card. Returns the card element.
   *  @param key Unique key for storage and dismissal.
   *  Backward compat: if called with 3 args (old signature), auto-generates key. */
export function createLiveCard(key: string, customType: string, label: string, content: string) {
    // Backward compat: old 3-arg call createLiveCard(customType, label, content)
    if (content === undefined) {
      content = label;
      label = customType;
      customType = key;
      key = customType + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    }
    var lc = new LiveCard({
      cardType: customType,
      label: label,
      content: renderMarkdown(content),
      onDismiss: function () { dismissLiveCard(key); },
    });
    lc.el._component = lc; // attach for later updating
    state.livePanel.appendChild(lc.el);
    state.liveCards[key as string] = lc.el;
    state.livePanel.classList.add("visible");
    return lc.el;
  }

  // ═══ Event Router ═══════════════════════════════════════
  // ═══ Event Router ═══════════════════════════════════════

function handleExtensionMessage(msg: any): void {
    // ── Layer 1: Runtime protocol validation ───────────────
    // Validate every incoming message against the Zod schema.
    // Skip validation for high-frequency streaming types to avoid
    // per-token overhead (every delta would parse the full union).
    var skipValidation = msg.type === "stream-delta" || msg.type === "thinking-delta" ||
                         msg.type === "tool-update" || msg.type === "bash-output";
    if (!skipValidation) {
      var vr = validateExtensionToWebview(msg);
      if (!vr.success) {
        console.warn("[pi-on-code] Webview message validation failed:", vr.error, "msg:", JSON.stringify(msg).substring(0, 300));
        // Show a visible diagnostic notification
        var diagKey = "pi-on-code-diagnostic-" + Date.now();
        var diag = createLiveCard(diagKey, "pi-on-code-diagnostic", "Protocol Error",
          "Message validation error for type `" + (msg.type || "unknown") + "`:\n```\n" +
          vr.error.substring(0, 500) + "\n```");
        // Don't block — fall through to existing handler for backward compat
      }
    }

    // Debug: log every incoming extension message (skip high-frequency stream deltas)
    if (msg.type === "history-page") {
      logEvent("recv:history-page", {
        eventCount: Array.isArray(msg.data?.events) ? msg.data.events.length : 0,
        hasMoreHistory: msg.data?.hasMoreHistory === true,
      });
    } else if (msg.type !== "stream-delta" && msg.type !== "thinking-delta" && msg.type !== "tool-update" && msg.type !== "bash-output") {
      logEvent("recv:" + msg.type, msg.data || msg);
    }
    switch (msg.type) {
      // Agent lifecycle
      case "agent-start":         handleAgentStart(); break;
      case "agent-end":           handleAgentEnd(); break;

      // Message lifecycle
      case "chat-message":        handleChatMessage(msg.data); break;
      case "turn-start":          handleTurnStart(msg.data); break;
      case "turn-end":            handleTurnEnd(msg.data); break;

      // Message lifecycle
      case "assistant-start":     handleAssistantStart(msg.data); break;
      case "assistant-end":       handleAssistantEnd(msg.data); break;
      case "stream-delta":        handleStreamDelta(msg.data); break;
      case "thinking-delta":      handleThinkingDelta(msg.data); break;

      // Tool lifecycle
      case "tool-start":          handleToolStart(msg.data); break;
      case "tool-update":         handleToolUpdate(msg.data); break;
      case "tool-end":            handleToolEnd(msg.data); break;

      // Session events
      case "status-update":       handleStatusUpdate(msg.data); break;
      case "status":              handleStatus(msg.data); break;
      case "queue-update":        logEvent("queue-update", { s: msg.data?.steering?.length, f: msg.data?.followUp?.length }); handleQueueUpdate(msg.data); break;
      case "editor-context-update": handleEditorContextUpdate(msg.data); break;
      case "workspace-files-update": handleWorkspaceFilesUpdate(msg.data); break;
      case "attach-workspace-file": addWorkspaceFileAttachment(msg.data); break;
      case "compaction-start":    handleCompactionStart(msg.data); break;
      case "compaction-end":      handleCompactionEnd(msg.data); break;
      case "auto-retry-start":    handleAutoRetryStart(msg.data); break;
      case "auto-retry-end":      handleAutoRetryEnd(msg.data); break;
      case "thinking-level-changed": handleThinkingLevelChanged(msg.data); break;
      case "batch-start":         handleBatchStart(msg.data); break;
      case "batch-end":           handleBatchEnd(msg.data); break;
      case "history-page":        handleHistoryPage(msg.data); break;
      case "conversation-turns-update":
        window.dispatchEvent(new CustomEvent(CONVERSATION_TURNS_EVENT, { detail: msg.data?.turns ?? [] }));
        break;

      // New features (#1, #2, #7, #9)
      case "compaction-summary-message": handleCompactionSummaryMessage(msg.data); break;
      case "bash-start":         handleBashStart(msg.data); break;
      case "bash-output":        handleBashOutput(msg.data); break;
      case "bash-end":           handleBashEnd(msg.data); break;
      case "custom-message":     handleCustomMessage(msg.data); break;
      case "user-messages-list": handleUserMessagesList(msg.data); break;
      case "scoped-models-update": handleScopedModelsUpdate(msg.data); break;
      case "settings-update":    handleSettingsUpdate(msg.data); break;
      case "revealEntry":        handleRevealEntry(msg.entryId, msg.toolCallId); break;

      // Errors
      case "error":               handleError(msg.data); break;

      // UI commands from extension host
      case "sessionReset":        resetChat(); break;
      case "insertCommand":       handleInsertCommand(msg.command); break;
      case "viewport-refresh":    window.dispatchEvent(new Event("pi-viewport-refresh")); break;

      // Extensions and slash commands active in this session
      case "capabilities-update": handleCapabilitiesUpdate(msg.data); break;
      case "capabilities-panel-update": handleCapabilitiesPanelUpdate(msg.data); break;
      case "slash-commands-update": handleSlashCommandsUpdate(msg.data); break;

      // Widget bridge from extensions (setWidget calls)
      case "widget-update":      handleWidgetUpdate(msg.data); break;
      case "registerMessageRenderer": handleRegisterMessageRenderer(msg.data); break;
      case "show_dialog":          handleShowDialog(msg.data); break;
      case "custom-ui-open":       handleCustomUiOpen(msg.data); break;
      case "custom-ui-update":     handleCustomUiUpdate(msg.data); break;
      case "custom-ui-close":      handleCustomUiClose(msg.data); break;

      default:
        // Surface unknown message types as visible notifications.
        // Skip high-frequency types that we intentionally don't render.
        if (msg.type !== "stream-delta" && msg.type !== "thinking-delta") {
          defaultMessageRenderer({
            customType: "pi-on-code-diagnostic",
            content: "Unhandled webview message: " + msg.type,
          });
        }
        break;
    }
  }

  window.addEventListener("message", function (event) {
    handleExtensionMessage(event.data);
  });

  // ═══ Agent Lifecycle ═══════════════════════════════════
  // ═══ Agent Lifecycle ═══════════════════════════════════

export function handleAgentStart() {
    logEvent("agent-start", { bashBlocksN: Object.keys(state.bashBlocks).length, toolBlocksN: Object.keys(state.currentToolBlocks).length });
    state.isStreaming = true;
    state.queueMode = "steer";  // reset to default on new stream
    state.assistantToolCallIds = {};
    // Do NOT clear the live panel here — extension cards (like tldr summaries)
    // should persist across prompts and be replaced only when new output of
    // the same type arrives, or when the extension explicitly removes them.
    addWorkingIndicator();
    moveWorkingIndicatorToBottom();
    updateStreamingState();
    setSbDot("streaming");
  }

export function handleAgentEnd() {
    setSbDot("idle");
    // Stop thinking spinner (safety net) — use component API if available
    if (state.currentThinkingEl) {
      var tb = state.currentThinkingEl._component as any;
      if (tb) {
        tb.update({ content: tb._rawText || "", done: true });
      } else {
        var thSpinner = state.currentThinkingEl.querySelector(".thinking-spinner");
        if (thSpinner) {thSpinner.remove();}
      }
    }

    logEvent("agent-end:BEFORE", {
      bashBlocksN: Object.keys(state.bashBlocks).length,
      toolBlocksN: Object.keys(state.currentToolBlocks).length,
      bashKeys: Object.keys(state.bashBlocks),
      toolKeys: Object.keys(state.currentToolBlocks),
    });
    state.isStreaming = false;
    state.isRetrying = false;
    state.assistantToolCallIds = {};
    removeWorkingIndicator();
    removeCompactionIndicator();
    removeRetryIndicator();

    // Flush any pending batched stream renders
    _flushStreamRender();

    // If there's a stale streaming component (e.g. aborted without message_end), finalize it
    if (state.currentAssistantEl) {
      var mc = state.currentAssistantEl.querySelector(".message-content");
      if (mc) {
        mc.classList.remove("streaming-cursor");
        var raw = mc.getAttribute("data-raw");
        if (raw) {
          var thinkingBlock = mc.querySelector(".thinking-block");
          if (state._markedAvailable) {
            while (mc.firstChild) { mc.removeChild(mc.firstChild); }
            var tokens = marked.lexer(raw);
            for (var ti = 0; ti < tokens.length; ti++) {
              mc.appendChild(renderBlock(tokens[ti]));
            }
            state._streamPrevTokens = [];
          } else {
            mc.innerHTML = renderMarkdown(raw);
          }
          if (thinkingBlock) {
            mc.prepend(thinkingBlock);
          }
        }
      }
      state.currentAssistantEl = null;
      state.currentThinkingEl = null;
    }

    // Finalize any pending tool blocks
    Object.keys(state.currentToolBlocks).forEach(function (id) {
      var entry = state.currentToolBlocks[id];
      var block = (entry as any).el || entry;
      if (block && block.getAttribute("data-status") === "running") {
        var statusEl = block.querySelector(".tool-status");
        if (statusEl) {
          statusEl.textContent = "done";
          statusEl.className = "tool-status success";
        }
        block.setAttribute("data-status", "done");
        applyAutoToolResultCollapse(block);
      }
    });
    state.currentToolBlocks = {};

    // Also finalize any dangling bash blocks that were never closed
    Object.keys(state.bashBlocks).forEach(function (id) {
      var block = state.bashBlocks[id as string];
      if (block && block.getAttribute && block.getAttribute("data-status") === "running") {
        logEvent("agent-end:ORPHAN-BASH", { toolCallId: id, inDOM: !!block.parentElement });
        block.setAttribute("data-status", "done");
        var footer = block.querySelector(".bash-footer");
        if (footer) { footer.innerHTML = '<span class="exit-code">exit: -</span> <span>(ended)</span>'; }
        applyAutoToolResultCollapse(block);
        delete state.bashBlocks[id as string];
        delete state.bashOutputs[id];
      }
    });

    updateStreamingState();
  }

  // ═══ Turn Lifecycle ════════════════════════════════════
  // ═══ Turn Lifecycle ════════════════════════════════════

export function handleTurnStart(data: any) {
    hideWelcome();
  }

export function handleTurnEnd(data: any) {
    if (data && data.message && data.message.role === "assistant" && data.message.errorMessage) {
      if (state.currentAssistantEl) {
        addErrorToElement(state.currentAssistantEl, data.message.errorMessage);
      }
    }
  }

  // ═══ Message Lifecycle ═════════════════════════════════
  // ═══ Message Lifecycle ═════════════════════════════════

function openMessageImage(src: string, alt: string): void {
    document.querySelector(".message-image-lightbox")?.remove();

    var overlay = document.createElement("div");
    overlay.className = "message-image-lightbox";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", alt);

    var fullImage = document.createElement("img");
    fullImage.className = "message-image-full";
    fullImage.src = src;
    fullImage.alt = alt;

    var closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "message-image-close";
    closeButton.textContent = "×";
    closeButton.setAttribute("aria-label", "Close image preview");

    var close = function (): void {
      document.removeEventListener("keydown", onKeydown);
      overlay.remove();
    };
    var onKeydown = function (event: KeyboardEvent): void {
      if (event.key === "Escape") { close(); }
    };

    closeButton.addEventListener("click", close);
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) { close(); }
    });
    document.addEventListener("keydown", onKeydown);
    overlay.append(fullImage, closeButton);
    document.body.appendChild(overlay);
    closeButton.focus();
  }

function createMessageEditorContext(items: unknown): HTMLElement | null {
    if (!Array.isArray(items) || items.length === 0) { return null; }

    var details = document.createElement("details");
    details.className = "message-editor-context";
    var summary = document.createElement("summary");
    summary.textContent = "Editor context · " + items.length + (items.length === 1 ? " item" : " items");
    details.appendChild(summary);

    var list = document.createElement("div");
    list.className = "message-editor-context-list";
    items.forEach(function (item: any) {
      if (!item || typeof item.path !== "string") { return; }
      var row = document.createElement("div");
      row.className = "message-editor-context-item";
      var name = document.createElement("span");
      name.className = "message-editor-context-path";
      name.textContent = item.path;
      name.title = item.path;
      var meta = document.createElement("span");
      meta.className = "message-editor-context-meta";
      var labels = [];
      if (item.attached) { labels.push("@ attached"); }
      if (item.kind === "folder") { labels.push("folder listing"); }
      if (item.external) { labels.push("external"); }
      if (item.active) {
        labels.push(item.selectionLines ? item.selectionLines + " selected lines" : "active");
      }
      if (item.dirty) { labels.push("unsaved"); }
      meta.textContent = labels.join(" · ");
      row.append(name, meta);
      list.appendChild(row);
    });
    details.appendChild(list);
    return details;
  }

function createMessageImages(images: unknown): HTMLElement | null {
    if (!Array.isArray(images) || images.length === 0) { return null; }

    var gallery = document.createElement("div");
    gallery.className = "message-images";
    for (var i = 0; i < images.length; i++) {
      var image = images[i];
      if (!image || image.type !== "image" || typeof image.data !== "string" ||
          typeof image.mimeType !== "string" || !image.mimeType.startsWith("image/")) {
        continue;
      }
      var button = document.createElement("button");
      button.type = "button";
      button.className = "message-image-button";
      button.title = "View full image";

      var img = document.createElement("img");
      img.className = "message-image";
      img.src = "data:" + image.mimeType + ";base64," + image.data;
      img.alt = "Attached image " + (i + 1);
      img.loading = "lazy";
      button.appendChild(img);
      button.addEventListener("click", function (event) {
        var target = event.currentTarget as HTMLElement;
        var preview = target.querySelector(".message-image") as HTMLImageElement | null;
        if (preview) { openMessageImage(preview.src, preview.alt); }
      });
      gallery.appendChild(button);
    }
    return gallery.childElementCount > 0 ? gallery : null;
  }

export function handleChatMessage(data: any) {
    var images = Array.isArray(data.images) ? data.images : [];
    var imageKey = images.map(function (image: any) {
      return String(image?.mimeType || "") + ":" + String(image?.data || "").slice(0, 64);
    }).join("|");
    var contextKey = Array.isArray(data.editorContext)
      ? data.editorContext.map(function (item: any) { return String(item?.id || ""); }).join("|")
      : "";
    var userMessageKey = String(data.content || "") + "\u0000" + imageKey + "\u0000" + contextKey;

    // Dedup repeated SDK/replay events while keeping image-only messages distinct.
    if (data.role === "user" && userMessageKey === state.lastUserMessageContent) {return;}
    if (data.role === "user") {
      state.lastUserMessageContent = userMessageKey;
      // Populate state.userMessageHistory for up-arrow recall (#2).
      if (data.content) {
        state.userMessageHistory.unshift({ text: data.content });
        if (state.userMessageHistory.length > 50) {state.userMessageHistory.pop();}
      }
    }

    hideWelcome();
    // Keep the working indicator throughout the complete agent run. It is
    // removed only by agent_end/error, not by intermediate message events.

    var el = createMessageEl(data.role);
    // #9: Entry ID for scroll-to
    if (data.entryId) {
      el.id = "entry-" + data.entryId;
      el.setAttribute("data-entry-id", data.entryId);
    }
    var mc = el.querySelector(".message-content");
    if (mc) {
      var imageGallery = createMessageImages(images);
      if (imageGallery) { mc.appendChild(imageGallery); }

      // Use block rendering for user messages (one-shot, no streaming)
      if (data.content && state._markedAvailable) {
        var tokens = marked.lexer(data.content);
        for (var ti = 0; ti < tokens.length; ti++) {
          mc.appendChild(renderBlock(tokens[ti]));
        }
      } else if (data.content) {
        var textContainer = document.createElement("div");
        textContainer.innerHTML = renderMarkdown(data.content);
        while (textContainer.firstChild) { mc.appendChild(textContainer.firstChild); }
      }

      var editorContext = createMessageEditorContext(data.editorContext);
      if (editorContext) { mc.appendChild(editorContext); }
    }
    if (data.role === "user" && typeof data.content === "string" && data.content.trim()) {
      var userCopyButton = document.createElement("button");
      userCopyButton.type = "button";
      userCopyButton.className = "user-copy-btn";
      userCopyButton.textContent = "Copy";
      userCopyButton.setAttribute("aria-label", "Copy user message");
      (userCopyButton as HTMLButtonElement & { _copyText?: string })._copyText = data.content;
      el.appendChild(userCopyButton);
    }
    state.chatContainer.appendChild(el);
    if (shouldPlaceWaitingIndicatorAfterMessage(data.role)) {
      var waitingIndicator = document.getElementById("working-indicator");
      if (waitingIndicator) {state.chatContainer.appendChild(waitingIndicator);}
    }
    scrollToBottom();
  }

export function handleAssistantStart(data: any) {
    hideWelcome();

    // Create the assistant container eagerly before any content arrives
    state.currentAssistantEl = createMessageEl("assistant");
    // #9: Entry ID for scroll-to
    if (data.entryId) {state.currentAssistantEl.id = "entry-" + data.entryId;}
    state.currentThinkingEl = null;
    state._streamPrevTokens = [];  // Reset token tracker for new message
    state.assistantToolCallIds = {};
    state.lastToolInsertionEl = null;  // New turn — reset tool insertion anchor
    state.chatContainer.appendChild(state.currentAssistantEl);
    moveWorkingIndicatorToBottom();
    scrollToBottom();
  }

export function handleAssistantEnd(data: any) {
    // Finalize the assistant message
    if (state.currentAssistantEl) {
      // Flush any pending batched renders before finalizing
      _flushStreamRender();
      var mc = state.currentAssistantEl.querySelector(".message-content");
      if (mc) {
        mc.classList.remove("streaming-cursor");
        // Final clean render from data-raw using block rendering
        var raw = mc.getAttribute("data-raw");
        if (raw) {
          var thinkingBlock = mc.querySelector(".thinking-block");
          if (state._markedAvailable) {
            // Re-render markdown content from the accumulated raw text.
            // Only remove text/block children — preserve tool blocks,
            // thinking blocks, and other non-markdown content that may
            // have been rendered into .message-content by extensions.
            var kids = Array.from(mc.children);
            for (var ki = 0; ki < kids.length; ki++) {
              var kid = kids[ki];
              // Skip tool blocks, thinking blocks, and anything that
              // wasn't produced by our markdown rendering.
              if (kid === thinkingBlock) { continue; }
              if (kid.classList.contains("tool-block")) { continue; }
              if (kid.classList.contains("bash-execution")) { continue; }
              kid.remove();
            }
            var tokens = marked.lexer(raw);
            for (var ti = 0; ti < tokens.length; ti++) {
              mc.appendChild(renderBlock(tokens[ti]));
            }
            state._streamPrevTokens = [];
          } else {
            mc.innerHTML = renderMarkdown(raw);
          }
          if (thinkingBlock) {
            mc.prepend(thinkingBlock);
          }
        }
      }

      const copyText = mc?.getAttribute("data-raw");
      if (copyText?.trim() && !state.currentAssistantEl.querySelector(".assistant-copy-btn")) {
        const copyButton = document.createElement("button");
        copyButton.type = "button";
        copyButton.className = "assistant-copy-btn";
        copyButton.textContent = "Copy";
        copyButton.setAttribute("aria-label", "Copy assistant response");
        (copyButton as HTMLButtonElement & { _copyText?: string })._copyText = copyText;
        state.currentAssistantEl.appendChild(copyButton);
      }

      // Handle error/abort stop reasons (like TUI)
      if (data && data.stopReason) {
        if (data.stopReason === "aborted") {
          addErrorToElement(state.currentAssistantEl, data.errorMessage || "Operation aborted");
          // Mark any pending tool blocks as errored
          if (data.toolCalls) {
            data.toolCalls.forEach(function (tcId: string) {
              var entry = state.currentToolBlocks[tcId as string];
              var block = entry ? ((entry as any).el || entry) : null;
              if (block) {
                var statusEl = block.querySelector(".tool-status");
                if (statusEl) {
                  statusEl.textContent = "error";
                  statusEl.className = "tool-status error";
                }
                block.setAttribute("data-status", "error");
                delete state.currentToolBlocks[tcId as string];
              }
            });
          }
        } else if (data.stopReason === "error") {
          addErrorToElement(state.currentAssistantEl, data.errorMessage || "Error");
        }
      }

      state.currentAssistantEl = null;
      state.currentThinkingEl = null;
    }
  }

  // ── rAF-batched stream rendering (token-diff) ────────
  // ── rAF-batched stream rendering (token-diff) ────────
  // Uses marked.lexer() to re-parse on every frame, then diffs
  // the token lists: only the last (in-progress) block is morphed;
  // all prior completed blocks are untouched. This avoids O(n²)
  // full-content re-renders during streaming.

export function _scheduleStreamRender(contentEl: HTMLElement) {
    if (state._streamRafId) {return;}
    state._streamContentEl = contentEl;
    state._streamRafId = requestAnimationFrame(function () {
      state._streamRafId = null;
      if (!state._streamContentEl) {return;}
      var el = state._streamContentEl;
      state._streamContentEl = null;

      // Save thinking block before patching (it's prepended, not part of blocks)
      var savedThinkingBlock = state.currentThinkingEl || el.querySelector(".thinking-block");
      // Temporarily detach thinking block so patchBlockList only sees token children
      if (savedThinkingBlock && savedThinkingBlock.parentNode === el) {
        el.removeChild(savedThinkingBlock);
      }

      var raw = el.getAttribute("data-raw") || "";
      if (state._markedAvailable) {
        var tokens = marked.lexer(raw);
        patchBlockList(el, state._streamPrevTokens, tokens);
        state._streamPrevTokens = tokens;
      } else {
        morphRender(el, renderMarkdown(raw));
      }

      if (savedThinkingBlock) {
        el.prepend(savedThinkingBlock);
        if (!state.currentThinkingEl) {
          state.currentThinkingEl = savedThinkingBlock;
        }
      }
      el.classList.add("streaming-cursor");
      scrollToBottom();
    });
  }

  /** Flush any pending rAF render immediately (called before finalize). */
export function _flushStreamRender() {
    // Flush thinking text first so it's visible in the final render
    _flushThinkingRender();
    if (state._streamRafId) {
      cancelAnimationFrame(state._streamRafId);
      state._streamRafId = null;
      if (state._streamContentEl) {
        var el = state._streamContentEl;
        state._streamContentEl = null;

        var savedThinkingBlock = state.currentThinkingEl || el.querySelector(".thinking-block");
        // Temporarily detach thinking block so patchBlockList only sees token children
        if (savedThinkingBlock && savedThinkingBlock.parentNode === el) {
          el.removeChild(savedThinkingBlock);
        }
        var raw = el.getAttribute("data-raw") || "";
        if (state._markedAvailable) {
          var tokens = marked.lexer(raw);
          patchBlockList(el, state._streamPrevTokens, tokens);
          state._streamPrevTokens = tokens;
        } else {
          morphRender(el, renderMarkdown(raw));
        }

        if (savedThinkingBlock) {
          el.prepend(savedThinkingBlock);
          if (!state.currentThinkingEl) {
            state.currentThinkingEl = savedThinkingBlock;
          }
        }
        el.classList.add("streaming-cursor");
      }
    }
  }

export function handleStreamDelta(data: any) {
    hideWelcome();
    if (!state.currentAssistantEl) {
      // Safety: create container if assistant-start was missed
      state.currentAssistantEl = createMessageEl("assistant");
      state.currentThinkingEl = null;
      state._streamPrevTokens = [];
      state.chatContainer.appendChild(state.currentAssistantEl);
      moveWorkingIndicatorToBottom();
    }
    var contentEl = state.currentAssistantEl.querySelector(".message-content");
    if (contentEl) {
      // Accumulate delta into data-raw (the source of truth)
      var raw = contentEl.getAttribute("data-raw") || "";
      raw += data.delta;
      contentEl.setAttribute("data-raw", raw);

      // Schedule a single render per animation frame
      _scheduleStreamRender(contentEl);
    }
    moveWorkingIndicatorToBottom();
    scrollToBottom();
  }

  // ── rAF-batched thinking delta ───────────────────────
  // ── rAF-batched thinking delta ───────────────────────
  // Uses textContent (no HTML parse) for efficiency, batched
  // per animation frame like stream deltas.

export function _scheduleThinkingRender(el: HTMLElement) {
    if (state._thinkingRafId) {return;}
    state._thinkingEl = el;
    state._thinkingRafId = requestAnimationFrame(function () {
      state._thinkingRafId = null;
      if (!state._thinkingEl) {return;}
      var el = state._thinkingEl;
      state._thinkingEl = null;
      var tb = el._component as any;
      if (tb) {
        tb.update({ content: tb._rawText || "" });
        tb.scrollToBottom();
      }
      scrollToBottom();
    });
  }

export function _flushThinkingRender() {
    if (state._thinkingRafId) {
      cancelAnimationFrame(state._thinkingRafId);
      state._thinkingRafId = null;
      if (state._thinkingEl) {
        var el = state._thinkingEl;
        state._thinkingEl = null;
        var tb = el._component as any;
        if (tb) {
          tb.update({ content: tb._rawText || "" });
        }
      }
    }
  }

export function handleThinkingDelta(data: any) {
    if (data.done) {
      _flushThinkingRender();
      // Finalize: update component with done=true (removes spinner, sets button)
      if (state.currentThinkingEl && state.currentThinkingEl._component) {
        var tb = state.currentThinkingEl._component as any;
        tb.update({ content: tb._rawText || "", done: true });
      }
      return;
    }
    if (!state.currentThinkingEl) {
      state.currentThinkingEl = createThinkingBlock("");
      if (state.currentAssistantEl) {
        var mc = state.currentAssistantEl.querySelector(".message-content");
        if (mc) {mc.prepend(state.currentThinkingEl);}
      }
    }
    var el = state.currentThinkingEl;
    if (el && el._component) {
      // Accumulate raw text, render once per frame via the component
      var tb = el._component as any;
      tb._rawText = (tb._rawText || "") + data.delta;
      _scheduleThinkingRender(el);
    }
    scrollToBottom();
  }

  // ═══ Session Events ════════════════════════════════════

  // ═══ In-webview status bar ═══════════════════════════

let sbDot = document.getElementById("pi-sb-dot");
let sbModel = document.getElementById("pi-sb-model");
let sbThinking = document.getElementById("pi-sb-thinking");
let sbEffort = document.getElementById("pi-sb-effort");
let sbCapabilities = document.getElementById("pi-sb-capabilities");
let sbUsage = document.getElementById("pi-sb-usage");

export function setSbDot(state: string) {
    if (!sbDot) {return;}
    sbDot.textContent = state === "streaming" ? "\u25CF" : "\u25CB";
  }

export function sbModelText(modelId: string) {
    var short = modelId || "Pi";
    // Shorten known prefixes for compact display
    if (short.startsWith("anthropic/")) {short = short.slice(10);}
    else if (short.startsWith("openai/")) {short = short.slice(7);}
    else if (short.startsWith("google/")) {short = short.slice(7);}
    if (short.length > 24) {short = short.slice(0, 22) + "\u2026";}
    return "\u03C0 " + short;
  }

export function handleCapabilitiesUpdate(data: unknown) {
    if (!sbCapabilities) { return; }
    const payload = data && typeof data === "object"
      ? data as { extensions?: unknown; skills?: unknown }
      : {};
    const names = (value: unknown): string[] => Array.isArray(value)
      ? value.flatMap((item): string[] => {
          if (!item || typeof item !== "object" || !("name" in item)) { return []; }
          const name = (item as { name?: unknown }).name;
          return typeof name === "string" ? [name] : [];
        })
      : [];
    const extensions = names(payload.extensions);
    const skills = names(payload.skills);
    const count = extensions.length + skills.length;
    sbCapabilities.textContent = `capabilities: ${count}`;
    sbCapabilities.title = count > 0
      ? [
          skills.length > 0 ? `Skills:\n${skills.join("\n")}` : "",
          extensions.length > 0 ? `Extensions:\n${extensions.join("\n")}` : "",
        ].filter(Boolean).join("\n\n")
      : "No Pi capabilities are active in this session";
  }

export function handleStatusUpdate(data: any) {
    if (data.reset) {return;}

    if (sbModel && data.model) {
      sbModel.textContent = sbModelText(data.model);
    }
    if (sbThinking) {
      sbThinking.textContent = "thinking: " + (data.thinkingLevel || "off");
    }
    if (sbEffort) {
      sbEffort.textContent = "effort: " + (data.effort || "auto");
    }
    if (sbUsage && data.usage) {
      var parts = [];
      var u = data.usage;
      if (u.input > 0) {parts.push("\u2191" + formatTokens(u.input));}
      if (u.output > 0) {parts.push("\u2193" + formatTokens(u.output));}
      if (u.cost > 0) {parts.push("$" + u.cost.toFixed(2));}
      if (u.contextPercent !== undefined) {parts.push(u.contextPercent.toFixed(0) + "%");}
      sbUsage.textContent = parts.length > 0 ? parts.join(" ") : "0%";
    }
    setSbDot(data.state.isStreaming ? "streaming" : "idle");
  }

export function handleStatus(data: any) {
    if (data.ready) {
      state.promptInput.disabled = false;
      state.sendButton.disabled = false;
      state.promptInput.placeholder = "Ask pi to do something...";
      state.promptInput.focus();
      if (sbModel && data.model) {
        sbModel.textContent = sbModelText(data.model);
      }
      if (sbThinking) {
        sbThinking.textContent = "thinking: " + (data.thinkingLevel || "off");
      }
      if (sbEffort) {
        sbEffort.textContent = "effort: " + (data.effort || "auto");
      }
      setSbDot("idle");
    } else if (data.model === "not installed" || data.model === "init failed") {
      state.promptInput.disabled = true;
      state.sendButton.disabled = true;
    }
  }

export function handleBatchStart(data: any) {
    // Hide the welcome screen before enabling batch mode because hideWelcome
    // intentionally ignores ordinary replay events while a batch is active.
    if (data?.hasEntries) { hideWelcome(); }
    state._inBatch = true;
    state.historyLoading = true;
    document.body.classList.add("no-animate");
  }

export function handleBatchEnd(data: any) {
    state._inBatch = false;
    if (data?.hasEntries === false) { showWelcome(); }
    state.historyHasMore = data?.hasMoreHistory === true;
    document.body.classList.remove("no-animate");
    // Force-scroll to bottom after the newest page is restored. Triple-rAF
    // lets markdown, code blocks, and syntax highlighting finish layout.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          var container = state.chatContainer;
          if (container.lastElementChild) {
            container.lastElementChild.scrollIntoView({ block: "end", behavior: "instant" });
          } else {
            container.scrollTop = container.scrollHeight;
          }
          state.historyLoading = false;
        });
      });
    });
  }

interface HistoryPrependContext {
  root: HTMLElement;
  staging: HTMLElement;
  previousScrollHeight: number;
  previousScrollTop: number;
  hasScrolledUp: boolean;
  workingIndicator: HTMLElement | null;
  currentAssistantEl: HTMLElement | null;
  currentThinkingEl: HTMLElement | null;
  currentToolBlocks: typeof state.currentToolBlocks;
  assistantToolCallIds: typeof state.assistantToolCallIds;
  lastToolInsertionEl: HTMLElement | null;
  bashBlocks: typeof state.bashBlocks;
  bashOutputs: typeof state.bashOutputs;
  lastUserMessageContent: string | null;
  userMessageHistory: typeof state.userMessageHistory;
  streamPrevTokens: unknown[];
}

let historyPrependContext: HistoryPrependContext | null = null;

export function handleHistoryPageStart(data: any) {
    if (historyPrependContext) { return; }

    // Finish any queued live render before temporarily switching the shared
    // render context. The atomic history-page message prevents new live
    // deltas from running until the context has been restored.
    _flushStreamRender();
    _flushThinkingRender();

    var root = state.chatContainer;
    var workingIndicator = document.getElementById("working-indicator");
    if (workingIndicator?.parentNode === root) { workingIndicator.remove(); }
    var staging = document.createElement("div");
    staging.className = "history-page-staging";
    staging.style.display = "contents";
    root.insertBefore(staging, root.firstChild);

    historyPrependContext = {
      root: root,
      staging: staging,
      previousScrollHeight: root.scrollHeight,
      previousScrollTop: root.scrollTop,
      hasScrolledUp: state.hasScrolledUp,
      workingIndicator: workingIndicator,
      currentAssistantEl: state.currentAssistantEl,
      currentThinkingEl: state.currentThinkingEl,
      currentToolBlocks: state.currentToolBlocks,
      assistantToolCallIds: state.assistantToolCallIds,
      lastToolInsertionEl: state.lastToolInsertionEl,
      bashBlocks: state.bashBlocks,
      bashOutputs: state.bashOutputs,
      lastUserMessageContent: state.lastUserMessageContent,
      userMessageHistory: state.userMessageHistory,
      streamPrevTokens: state._streamPrevTokens,
    };

    state.chatContainer = staging;
    state.currentAssistantEl = null;
    state.currentThinkingEl = null;
    state.currentToolBlocks = {};
    state.assistantToolCallIds = {};
    state.lastToolInsertionEl = null;
    state.bashBlocks = {};
    state.bashOutputs = {};
    state.lastUserMessageContent = null;
    state.userMessageHistory = [];
    state._streamPrevTokens = [];
    state._inBatch = true;
    state.historyLoading = true;
    state.historyHasMore = data?.hasMoreHistory === true;
    document.body.classList.add("no-animate");
  }

export function handleHistoryPage(data: any) {
    handleHistoryPageStart(data);
    try {
      var events = Array.isArray(data?.events) ? data.events : [];
      for (var index = 0; index < events.length; index++) {
        var event = events[index];
        if (!event || typeof event !== "object") {
          console.warn("[pi-on-code] Ignoring malformed history event", event);
          continue;
        }
        handleExtensionMessage(event);
      }
    } finally {
      handleHistoryPageEnd(data);
    }
  }

export function handleHistoryPageEnd(data: any) {
    var context = historyPrependContext;
    if (!context) {
      state._inBatch = false;
      state.historyLoading = false;
      state.historyHasMore = data?.hasMoreHistory === true;
      return;
    }

    state.chatContainer = context.root;
    while (context.staging.firstChild) {
      context.root.insertBefore(context.staging.firstChild, context.staging);
    }
    context.staging.remove();
    if (context.workingIndicator) {
      context.root.appendChild(context.workingIndicator);
    }

    state.hasScrolledUp = context.hasScrolledUp;
    state.currentAssistantEl = context.currentAssistantEl;
    state.currentThinkingEl = context.currentThinkingEl;
    state.currentToolBlocks = context.currentToolBlocks;
    state.assistantToolCallIds = context.assistantToolCallIds;
    state.lastToolInsertionEl = context.lastToolInsertionEl;
    state.bashBlocks = context.bashBlocks;
    state.bashOutputs = context.bashOutputs;
    state.lastUserMessageContent = context.lastUserMessageContent;
    state.userMessageHistory = context.userMessageHistory;
    state._streamPrevTokens = context.streamPrevTokens;
    state._inBatch = false;
    state.historyHasMore = data?.hasMoreHistory === true;
    document.body.classList.remove("no-animate");
    historyPrependContext = null;
    const completedContext = context;

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        restoreScrollAfterPrepend(
          completedContext.root,
          completedContext.previousScrollHeight,
          completedContext.previousScrollTop,
        );
        state.historyLoading = false;
      });
    });
  }

function submitFollowUpQueue(messages: string[]): void {
    window.__vscode.postMessage({ type: "replaceFollowUpQueue", messages: messages });
  }

function openFollowUpEditor(index: number, text: string, messages: string[]): void {
    document.querySelector(".queue-edit-overlay")?.remove();

    var overlay = document.createElement("div");
    overlay.className = "queue-edit-overlay";
    var dialog = document.createElement("div");
    dialog.className = "queue-edit-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "Edit follow-up message");

    var title = document.createElement("div");
    title.className = "queue-edit-title";
    title.textContent = "Edit follow-up";
    var textarea = document.createElement("textarea");
    textarea.className = "queue-edit-textarea";
    textarea.value = text;
    textarea.rows = 8;
    var actions = document.createElement("div");
    actions.className = "queue-edit-actions";
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    var save = document.createElement("button");
    save.type = "button";
    save.className = "primary";
    save.textContent = "Save";

    var close = function (): void {
      document.removeEventListener("keydown", onKeydown);
      overlay.remove();
    };
    var onKeydown = function (event: KeyboardEvent): void {
      if (event.key === "Escape") { close(); }
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { save.click(); }
    };
    cancel.addEventListener("click", close);
    save.addEventListener("click", function () {
      var replacement = textarea.value.trim();
      if (!replacement) { return; }
      var updated = messages.slice();
      updated[index] = replacement;
      submitFollowUpQueue(updated);
      close();
    });
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) { close(); }
    });
    document.addEventListener("keydown", onKeydown);
    actions.append(cancel, save);
    dialog.append(title, textarea, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

export function handleQueueUpdate(data: any) {
    // Track for /debug inspection
    (window.__piDebug._queueEvents = window.__piDebug._queueEvents || []).push({
      ts: Date.now(),
      steering: (data.steering || []).length,
      followUp: (data.followUp || []).length,
      streaming: state.isStreaming,
    });
    if (window.__piDebug._queueEvents.length > 20) {window.__piDebug._queueEvents.shift();}

    var existing = document.getElementById("pending-queue-indicator");
    if (existing) {existing.remove();}

    var steering = data.steering || [];
    var followUp = data.followUp || [];
    if (steering.length === 0 && followUp.length === 0) {return;}

    var el = document.createElement("div");
    el.id = "pending-queue-indicator";
    el.className = "queue-indicator";

    var result = "";

    // Steering messages — already interrupting, show with label
    steering.forEach(function (m: any) {
      result += html`<div class="queue-row">
        <span class="queue-label">Steer:</span>
        <span class="queue-text">${m}</span></div>`;
    });

    // Follow-up messages — one-line, editable, and reorderable.
    followUp.forEach(function (m: any, i: number) {
      result += html`<div class="queue-row follow-up-row" data-idx="${i}" draggable="${followUp.length > 1 ? "true" : "false"}">
        <span class="queue-drag" title="Drag to reorder">⋮⋮</span>
        <span class="queue-label">Follow-up:</span>
        <span class="queue-text" title="${m}">${m}</span>
        <button class="queue-edit-btn" data-idx="${i}" title="Edit follow-up">Edit</button>
        <button class="queue-promote-btn" data-idx="${i}" title="Promote to Steer (interrupt now)">Steer now</button>
        </div>`;
    });

    // Clear all button — always show when there are items
    result += html`<div class="queue-actions">
      <button class="queue-clear-btn">✕ Clear pending</button>
      </div>`;

    el.innerHTML = result;

    // Wire edit buttons. Visibility is decided after layout so narrow panes
    // also expose Edit when the one-line text is actually truncated.
    el.querySelectorAll(".queue-edit-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var idx = parseInt(btn.getAttribute("data-idx") || "0", 10);
        var message = followUp[idx];
        if (message !== undefined) { openFollowUpEditor(idx, message, followUp); }
      });
    });

    // Wire drag-and-drop ordering for follow-up messages.
    var draggedIndex = -1;
    el.querySelectorAll(".follow-up-row").forEach(function (row) {
      row.addEventListener("dragstart", function (event) {
        draggedIndex = parseInt(row.getAttribute("data-idx") || "-1", 10);
        row.classList.add("dragging");
        if ((event as DragEvent).dataTransfer) {
          (event as DragEvent).dataTransfer!.effectAllowed = "move";
        }
      });
      row.addEventListener("dragover", function (event) {
        event.preventDefault();
        row.classList.add("drag-over");
      });
      row.addEventListener("dragleave", function () { row.classList.remove("drag-over"); });
      row.addEventListener("drop", function (event) {
        event.preventDefault();
        var targetIndex = parseInt(row.getAttribute("data-idx") || "-1", 10);
        if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) { return; }
        var reordered = followUp.slice();
        var moved = reordered.splice(draggedIndex, 1)[0];
        reordered.splice(targetIndex, 0, moved);
        handleQueueUpdate({ steering: steering, followUp: reordered });
        submitFollowUpQueue(reordered);
      });
      row.addEventListener("dragend", function () {
        draggedIndex = -1;
        el.querySelectorAll(".follow-up-row").forEach(function (item) {
          item.classList.remove("dragging", "drag-over");
        });
      });
    });

    // Wire promote buttons
    el.querySelectorAll(".queue-promote-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var idx = parseInt(btn.getAttribute("data-idx") || "0", 10);
        var msg = (data.followUp || [])[idx];
        if (msg) {
          // Promote: clear all queues, then re-steer this message
          window.__vscode.postMessage({ type: "promoteToSteer", text: msg });
        }
      });
    });

    // Wire clear button
    var clearBtn = el.querySelector(".queue-clear-btn");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        window.__vscode.postMessage({ type: "clearQueue" });
      });
    }

    var inputArea = document.getElementById("input-area");
    if (inputArea && inputArea.parentNode) {
      inputArea.parentNode.insertBefore(el, inputArea);
    }
    requestAnimationFrame(function () {
      el.querySelectorAll(".follow-up-row").forEach(function (row) {
        var text = row.querySelector(".queue-text");
        var edit = row.querySelector(".queue-edit-btn");
        if (text && edit && (text.scrollWidth > text.clientWidth || text.textContent?.includes("\n"))) {
          edit.classList.add("visible");
        }
      });
    });
  }

export function handleCompactionStart(data: any) {
    state.isCompacting = true;
    removeCompactionIndicator();
    addCompactionIndicator(data.reason === "manual" ? "Compacting..." : "Auto-compacting...");
    updateStreamingState();
  }

export function handleCompactionEnd(data: any) {
    state.isCompacting = false;
    removeCompactionIndicator();
    if (data.aborted) {
      addStatusMessage(data.reason === "manual" ? "Compaction cancelled" : "Auto-compaction cancelled");
    } else if (data.errorMessage) {
      addStatusMessage("Compaction error: " + data.errorMessage);
    } else if (data.result) {
      addStatusMessage("Compaction complete");
    }
    updateStreamingState();
  }

export function handleAutoRetryStart(data: any) {
    state.isRetrying = true;
    removeRetryIndicator();
    addRetryIndicator(data.attempt, data.maxAttempts, data.delayMs);
    updateStreamingState();
  }

export function handleAutoRetryEnd(data: any) {
    state.isRetrying = false;
    removeRetryIndicator();
    if (!data.success) {
      addErrorMessage("Retry failed after " + data.attempt + " attempts: " + (data.finalError || "Unknown error"));
    }
    updateStreamingState();
  }

export function handleThinkingLevelChanged(data: any) {
    if (sbThinking && data.level) {
      sbThinking.textContent = "thinking: " + data.level;
    }
  }

  // ═══ Error Handling ════════════════════════════════════

export function handleError(data: any) {
    hideWelcome();
    var preserveWorking = shouldPreserveWorkingIndicator(
      state.isStreaming,
      state.isCompacting,
      state.isRetrying,
    );

    if (!preserveWorking) {
      removeWorkingIndicator();
      removeCompactionIndicator();
      removeRetryIndicator();
      state.isStreaming = false;
      if (state.currentAssistantEl) {
        var mc = state.currentAssistantEl.querySelector(".message-content");
        if (mc) {mc.classList.remove("streaming-cursor");}
        state.currentAssistantEl = null;
        state.currentThinkingEl = null;
      }
    }

    addErrorMessage(data.message || "Unknown error");
    if (preserveWorking) {moveWorkingIndicatorToBottom();}
    updateStreamingState();
    scrollToBottom();
  }

  // ═══ UI Helpers — Indicators ═══════════════════════════
  // ═══ UI Helpers — Indicators ═══════════════════════════

export function addWorkingIndicator(): void {
    var existing = document.getElementById("working-indicator");
    if (existing) {return;}
    var el = document.createElement("div");
    el.id = "working-indicator";
    el.className = "message assistant pi-waiting-indicator";
    el.setAttribute("role", "status");
    el.setAttribute("aria-label", "Pi is thinking");
    el.innerHTML = html`
      <div class="message-content">
        <span class="working-spinner" aria-hidden="true">${PI_TUI_SPINNER_FRAMES[0]}</span>
        <span class="pi-waiting-text">Working...</span>
      </div>`;
    state.chatContainer.appendChild(el);
    scrollToBottom();

    var frame = 0;
    el._spinnerInterval = setInterval(function () {
      frame = nextWaitingFrame(frame);
      var spinner = el.querySelector(".working-spinner");
      if (spinner) {spinner.textContent = PI_TUI_SPINNER_FRAMES[frame];}
    }, 80);
  }

export function moveWorkingIndicatorToBottom(): void {
    var indicator = document.getElementById("working-indicator");
    if (indicator && indicator.parentNode === state.chatContainer && indicator !== state.chatContainer.lastElementChild) {
      state.chatContainer.appendChild(indicator);
    }
  }

export function removeWorkingIndicator(): void {
    var el = document.getElementById("working-indicator");
    if (el) {
      if (el._spinnerInterval) {clearInterval(el._spinnerInterval);}
      el.remove();
    }
  }

export function addCompactionIndicator(message: string) {
    var existing = document.getElementById("compaction-indicator");
    if (existing) {existing.remove();}
    var el = document.createElement("div");
    el.id = "compaction-indicator";
    el.className = "message assistant";
    el.innerHTML = html`
      <div class="message-content warning">
        <span class="working-spinner">◆</span> ${message}
      </div>`;
    state.chatContainer.appendChild(el);
    scrollToBottom();

    var frames = ["◇", "◆", "◇", "◆"];
    var frame = 0;
    el._spinnerInterval = setInterval(function () {
      frame = (frame + 1) % frames.length;
      var s = el.querySelector(".working-spinner");
      if (s) {s.textContent = frames[frame];}
    }, 400);
  }

export function removeCompactionIndicator() {
    var el = document.getElementById("compaction-indicator");
    if (el) {
      if (el._spinnerInterval) {clearInterval(el._spinnerInterval);}
      el.remove();
    }
  }

export function addRetryIndicator(attempt: number, maxAttempts: number, delayMs: number) {
    var existing = document.getElementById("retry-indicator");
    if (existing) {existing.remove();}
    var el = document.createElement("div");
    el.id = "retry-indicator";
    el.className = "message assistant";
    el.innerHTML =
      '<div class="message-content warning">' +
      '<span class="working-spinner">↻</span> Retrying (' + attempt + '/' + maxAttempts +
      ') in ' + Math.ceil(delayMs / 1000) + 's...</div>';
    state.chatContainer.appendChild(el);
    scrollToBottom();

    // Countdown
    var remaining = delayMs;
    el._countdownInterval = setInterval(function () {
      remaining -= 1000;
      if (remaining <= 0) {
        var span = el.querySelector(".retry-countdown");
        if (span) {span.textContent = "0s";}
        clearInterval(el._countdownInterval);
      } else {
        var spans = el.querySelectorAll("span");
        var textNode = el.querySelector(".message-content");
        if (textNode) {
          textNode.innerHTML =
            '<span class="working-spinner">↻</span> Retrying (' + attempt + '/' + maxAttempts +
            ') in ' + Math.ceil(remaining / 1000) + 's...';
        }
      }
    }, 1000);
  }

export function removeRetryIndicator() {
    var el = document.getElementById("retry-indicator");
    if (el) {
      if (el._countdownInterval) {clearInterval(el._countdownInterval);}
      el.remove();
    }
  }

  // ═══ UI Helpers — Chat additions ═══════════════════════
  // ═══ UI Helpers — Chat additions ═══════════════════════

export function addStatusMessage(message: string) {
    var el = document.createElement("div");
    el.className = "message assistant";
    el.innerHTML = html`<div class="message-content muted">${message}</div>`;
    state.chatContainer.appendChild(el);
    scrollToBottom();
  }

export function showQuickstartGuide() {
    // Remove any previous guide
    var existing = document.getElementById("quickstart-guide");
    if (existing) {existing.remove();}

    var el = document.createElement("div");
    el.id = "quickstart-guide";
    el.className = "message assistant";
    el.innerHTML =
      '<details class="thinking-block" open>' +
      '<summary>📖 Getting started with Pi</summary>' +
      '<div class="quickstart-content">' +

      '<h3>1. Get an API key</h3>' +
      '<p>Pi works with any LLM provider. You need at least one:</p>' +
      '<ul>' +
      '<li><strong>Anthropic (Claude)</strong> — <a href="https://console.anthropic.com/">console.anthropic.com</a> → API Keys</li>' +
      '<li><strong>OpenAI</strong> — <a href="https://platform.openai.com/api-keys">platform.openai.com/api-keys</a></li>' +
      '<li><strong>Google Gemini</strong> — <a href="https://aistudio.google.com/apikey">aistudio.google.com</a> (free tier)</li>' +
      '<li><strong>DeepSeek</strong> — <a href="https://platform.deepseek.com/api_keys">platform.deepseek.com</a> (very cheap)</li>' +
      '</ul>' +

      '<h3>🆓 Free & local options</h3>' +
      '<ul>' +
      '<li><strong>Ollama</strong> — run models locally or use cloud-hosted. <a href="https://ollama.com">ollama.com</a></li>' +
      '<li><strong>OpenRouter</strong> — unified API with free models. <a href="https://openrouter.ai/models?max_price=0">openrouter.ai/models?max_price=0</a></li>' +
      '<li><strong>GitHub Copilot</strong> — use <code>/login</code> in Pi and select Copilot (included with GitHub Copilot subscription)</li>' +
      '</ul>' +

      '<h3>2. Set the key</h3>' +
      '<p><strong>Option A:</strong> Run <strong>Pi: Set Up API Key / Login</strong> from the command palette (<code>Ctrl+Shift+P</code>)</p>' +
      '<p><strong>Option B:</strong> Set an environment variable before opening VS Code:</p>' +
      '<pre><code>export ANTHROPIC_API_KEY=sk-ant-...\n# or\nexport OPENAI_API_KEY=sk-...</code></pre>' +

      '<h3>3. Start chatting</h3>' +
      '<p>Once your key is set, type a request and press Enter:</p>' +
      '<pre><code>Summarize this project and tell me how to run its checks.</code></pre>' +

      '<p style="margin-top:12px"><a href="https://pi.dev/docs/latest/quickstart">📚 Full quickstart guide →</a>  ·  ' +
      '<a href="https://pi.dev/docs/latest/providers">🔑 All supported providers →</a></p>' +

      '</div>' +
      '</details>';
    state.chatContainer.appendChild(el);
  }

export function addErrorMessage(message: string) {
    var el = document.createElement("div");
    el.className = "message assistant";

    // Detect error type to show appropriate heading and help
    var heading = "";
    var help = "";
    var msg = message || "";
    var isApiKeyError = false;

    if (/api.?key/i.test(msg)) {
      heading = "<strong>API key required</strong>";
      help = '<small>Run <strong>Pi: Set Up API Key / Login</strong> from the command palette ' +
             '(<code>Ctrl+Shift+P</code>), or set <code>ANTHROPIC_API_KEY</code> / ' +
             '<code>OPENAI_API_KEY</code> in your environment.</small>';
      isApiKeyError = true;
    } else if (/not installed|not found|not available|npm install/i.test(msg)) {
      heading = "<strong>Pi is not available</strong>";
      help = '<small>Run <code>npm install -g @earendil-works/pi-coding-agent</code> in a terminal, then reload VS Code.</small>';
    } else {
      heading = "<strong>Something went wrong</strong>";
      help = '<small>Check the error above for details.</small>';
    }

    el.innerHTML =
      '<div class="message-content error">' +
      '⚠ ' + heading + '<br><br>' +
      renderMarkdown(msg) +
      '<br><br>' + help +
      '</div>';
    state.chatContainer.appendChild(el);

    // Show inline quickstart guide for API key errors
    if (isApiKeyError) {
      showQuickstartGuide();
    }

    scrollToBottom();
  }

export function addErrorToElement(parentEl: HTMLElement, message: string) {
    if (!parentEl) {return;}
    var errorEl = document.createElement("div");
    errorEl.className = 'message-content error'; errorEl.style.cssText = 'margin-top: 8px; padding: 4px 0;';
    errorEl.textContent = "\u26A0 " + message;
    parentEl.appendChild(errorEl);
  }

  // ═══ UI Helpers — Tool Block ═══════════════════════════
  // ═══ Input Handling ════════════════════════════════════

  // ═══ Attachment Handling ═══════════════════════════════

export function generateAttId() {
    return "att_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  }

export function clearAttachments() {
    // Revoke blob URLs to free memory
    state.attachments.forEach(function (a) {
      if (a.blobUrl) {URL.revokeObjectURL(a.blobUrl);}
    });
    state.attachments = [];
    renderAttachments();
  }

export function removeAttachment(id: string) {
    var idx = state.attachments.findIndex(function (a) { return a.id === id; });
    if (idx === -1) {return;}
    var att = state.attachments[idx];
    if (att.blobUrl) {URL.revokeObjectURL(att.blobUrl);}
    state.attachments.splice(idx, 1);
    renderAttachments();
  }

export function removeEditorContext(id: string): void {
    state.dismissedEditorContextIds[id] = true;
    renderAttachments();
  }

export function handleEditorContextUpdate(data: any): void {
    state.editorContextItems = Array.isArray(data?.items) ? data.items : [];
    renderAttachments();
  }

export function removeWorkspaceFileAttachment(id: string): void {
    state.workspaceFileAttachments = state.workspaceFileAttachments.filter(function (item) {
      return item.id !== id;
    });
    renderAttachments();
  }

export function renderAttachments(): void {
    if (!state.attachmentBar) {return;}

    var visibleEditorContext = state.editorContextItems.filter(function (item) {
      return !state.dismissedEditorContextIds[item.id] &&
        !state.workspaceFileAttachments.some(function (attached) { return attached.id === item.id; });
    });
    if (state.attachments.length === 0 && visibleEditorContext.length === 0 &&
        state.workspaceFileAttachments.length === 0) {
      state.attachmentBar.classList.remove("visible");
      state.attachmentBar.innerHTML = "";
      return;
    }

    state.attachmentBar.classList.add("visible");
    var result = "";

    for (var i = 0; i < state.attachments.length; i++) {
      var a = state.attachments[i];

      if (a.type === "image") {
        var src = a.blobUrl || "";
        result += html`
          <div class="attachment-item" title="${a.name}">
            <img class="att-preview" src="${src}" alt="">
            <span class="att-name">${a.name}</span>
            <span class="att-remove" data-att-id="${a.id}">&times;</span>
          </div>`;
      } else {
        result += html`
          <div class="attachment-item" title="${a.name}">
            <span class="att-icon">&#128196;</span>
            <span class="att-name">${a.name}</span>
            <span class="att-remove" data-att-id="${a.id}">&times;</span>
          </div>`;
      }
    }

    for (var wi = 0; wi < state.workspaceFileAttachments.length; wi++) {
      var workspaceFile = state.workspaceFileAttachments[wi];
      var attachmentMeta = workspaceFile.kind === "folder"
        ? (workspaceFile.external ? "external folder · listing only" : "folder · listing only")
        : (workspaceFile.external ? "external file" : "workspace file");
      result += html`
        <div class="attachment-item workspace-file-attachment" title="${workspaceFile.path}">
          <span class="att-icon att-workspace-icon">${workspaceFile.kind === "folder" ? "▣" : "@"}</span>
          <span class="att-context-copy">
            <span class="att-name">${workspaceFile.name}</span>
            <span class="att-meta">${attachmentMeta}</span>
          </span>
          <button class="att-remove" type="button" data-workspace-file-id="${workspaceFile.id}" aria-label="Remove ${workspaceFile.name} from context">&times;</button>
        </div>`;
    }

    for (var ci = 0; ci < visibleEditorContext.length; ci++) {
      var context = visibleEditorContext[ci];
      var contextMeta = context.active
        ? (context.selectionLines ? context.selectionLines + " selected lines" : "active file")
        : "visible file";
      if (context.dirty) { contextMeta += " · unsaved"; }
      result += html`
        <div class="attachment-item editor-context-attachment" title="${context.path}">
          <span class="att-icon att-context-icon">&lt;/&gt;</span>
          <span class="att-context-copy">
            <span class="att-name">${context.name}</span>
            <span class="att-meta">${contextMeta}</span>
          </span>
          <button class="att-remove" type="button" data-editor-context-id="${context.id}" aria-label="Remove ${context.name} from editor context">&times;</button>
        </div>`;
    }

    state.attachmentBar.innerHTML = result;

    // Delegate click events for remove buttons
    state.attachmentBar.querySelectorAll(".att-remove[data-att-id]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        var id = (e.currentTarget as HTMLElement).getAttribute("data-att-id");
        if (id) {removeAttachment(id);}
      });
    });
    state.attachmentBar.querySelectorAll(".att-remove[data-editor-context-id]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        var id = (e.currentTarget as HTMLElement).getAttribute("data-editor-context-id");
        if (id) {removeEditorContext(id);}
      });
    });
    state.attachmentBar.querySelectorAll(".att-remove[data-workspace-file-id]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        var id = (e.currentTarget as HTMLElement).getAttribute("data-workspace-file-id");
        if (id) {removeWorkspaceFileAttachment(id);}
      });
    });
  }

  // ── Paste handler ──────────────────────────────────────

  state.promptInput.addEventListener("paste", function (e) {
    var items = e.clipboardData?.items;
    if (!items) {return;}
    if (!items) {return;}

    var imageItems = [];
    var fileItems = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.type.startsWith("image/")) {
        imageItems.push(item);
      } else if (item.kind === "file") {
        fileItems.push(item);
      }
    }

    if (imageItems.length === 0 && fileItems.length === 0) {return;}

    e.preventDefault();

    // Capture any text from the clipboard too
    var pastedText = e.clipboardData?.getData("text/plain") || "";

    // Process image items
    for (var j = 0; j < imageItems.length; j++) {
      (function (item) {
        var file = item.getAsFile();
        if (!file) {return;}

        var attId = generateAttId();
        var blobUrl = URL.createObjectURL(file);

        state.attachments.push({
          id: attId,
          type: "image",
          name: file.name || "pasted-image.png",
          mediaType: item.type,
          data: null,      // will be filled after FileReader
          blobUrl: blobUrl, // immediate preview
        });

        var reader = new FileReader(); reader.onload = function () { var result = reader.result as string; // "data:image/png;base64,..."
          var att = state.attachments.find(function (a) { return a.id === attId; });
          if (att) {
            att.data = result.split(",")[1]; // just the base64 payload
          }
          renderAttachments();
        };
        reader.readAsDataURL(file);

        renderAttachments();
      })(imageItems[j]);
    }

    // Process file items
    for (var k = 0; k < fileItems.length; k++) {
      (function (item) {
        var file = item.getAsFile();
        if (!file) {return;}

        var attId = generateAttId();

        state.attachments.push({
          id: attId,
          type: "file",
          name: file.name || "unknown-file",
          mediaType: item.type,
          data: null,
          blobUrl: null,
        });

        // Read text files; mark binary files
        if (item.type.startsWith("text/") || !item.type) {
          var reader = new FileReader();
          reader.onload = function () {
            var att = state.attachments.find(function (a) { return a.id === attId; });
            if (att) {
              att.data = reader.result as string;
            }
            renderAttachments();
          };
          reader.readAsText(file);
        } else {
          var att = state.attachments.find(function (a) { return a.id === attId; });
          if (att) {
            att.data = "[Binary file: " + file.name + "]";
          }
          renderAttachments();
        }

        renderAttachments();
      })(fileItems[k]);
    }

    // Insert clipboard text at cursor position
    if (pastedText) {
      var start = state.promptInput.selectionStart;
      var end = state.promptInput.selectionEnd;
      var val = state.promptInput.value;
      state.promptInput.value = val.slice(0, start) + pastedText + val.slice(end);
      state.promptInput.selectionStart = state.promptInput.selectionEnd = start + pastedText.length;
      state.promptInput.dispatchEvent(new Event("input"));
    }
  });

  // ── Send prompt ───────────────────────────────────────

export function sendPrompt(modeOverride?: "steer" | "queue"): void {
    console.log("[pi-on-code] sendPrompt called");
    var text = state.promptInput.value.trim();
    if (!text && state.attachments.length === 0 && state.workspaceFileAttachments.length === 0) {return;}

    // Reset scroll tracking — user clearly wants to follow the new response
    state.hasScrolledUp = false;

    // Intercept local slash commands before sending to LLM
    if (text && state.localSlashCommands.indexOf(text) !== -1) {
      var cmd = text.slice(1); // strip leading "/"

      // /debug: dump webview state as a structured message in chat, plus
      // log to console so it can be inspected from DevTools without copy-paste.
      if (cmd === "debug") {
        handleDebugCommand();
        state.promptInput.value = "";
        state.promptInput.style.height = "auto";
        state.promptInput.style.overflowY = "hidden";
        updateFollowUpHintVisibility();
        clearAttachments();
        return;
      }

      window.__vscode.postMessage({
        type: "slashCommand",
        command: cmd,
      });
      state.promptInput.value = "";
      state.promptInput.style.height = "auto";
      state.promptInput.style.overflowY = "hidden";
      updateFollowUpHintVisibility();
      clearAttachments();
      return;
    }

    // Build images array from image state.attachments with loaded data
    var images = state.attachments
      .filter(function (a) { return a.type === "image" && a.data; })
      .map(function (a) {
        return {
          type: "image",
          data: a.data,
          mimeType: a.mediaType,
        };
      });

    var wasStreaming = state.isStreaming;
    var includedEditorIds = state.editorContextItems
      .filter(function (item) { return !state.dismissedEditorContextIds[item.id]; })
      .map(function (item) { return item.id; });
    window.__vscode.postMessage({
      type: "prompt",
      text: text,
      images: images.length > 0 ? images : undefined,
      mode: wasStreaming ? (modeOverride ?? state.queueMode) : undefined,
      editorContext: wasStreaming ? undefined : {
        includedEditorIds: includedEditorIds,
        attachedFileIds: state.workspaceFileAttachments.map(function (item) { return item.id; }),
      },
    });

    // Give immediate feedback while the extension host prepares the request.
    // Queued/steering prompts already have an active response indicator.
    if (shouldShowPromptWaitingIndicator(wasStreaming, text)) {
      hideWelcome();
      addWorkingIndicator();
    }

    state.promptInput.value = "";
    state.promptInput.style.height = "auto";
    state.promptInput.style.overflowY = "hidden";
    updateFollowUpHintVisibility();
    clearAttachments();
    if (!wasStreaming) {
      state.dismissedEditorContextIds = {};
      state.workspaceFileAttachments = [];
      renderAttachments();
    }
  }

  state.sendButton.addEventListener("click", function () { sendPrompt(); });

  state.abortButton.addEventListener("click", function () {
    window.__vscode.postMessage({ type: "abort" });
  });

  // Steer dropdown — toggles between Steer and Follow-up mode.
  state.steerDropdown.addEventListener("click", function () {
    state.queueMode = state.queueMode === "steer" ? "queue" : "steer";
    updateStreamingState();
  });

  // ── In-webview status bar click handlers ─────────────
  if (sbModel) {
    sbModel.addEventListener("click", function () {
      window.__vscode.postMessage({ type: "pickModel" });
    });
  }
  if (sbThinking) {
    sbThinking.addEventListener("click", function () {
      window.__vscode.postMessage({ type: "pickThinkingLevel" });
    });
  }
  if (sbEffort) {
    sbEffort.addEventListener("click", function () {
      window.__vscode.postMessage({ type: "pickEffort" });
    });
  }
  if (sbCapabilities) {
    sbCapabilities.addEventListener("click", function () {
      toggleCapabilitiesPanel();
    });
  }
  if (sbUsage) {
    sbUsage.addEventListener("click", function () {
      window.__vscode.postMessage({ type: "pickContextBudget" });
    });
  }
let sbSettings = document.getElementById("pi-sb-settings");
  if (sbSettings) {
    sbSettings.addEventListener("click", function () {
      toggleSettingsPanel();
    });
  }

  // Handle external links and close overlays on outside clicks
  document.addEventListener("click", function (e) {
    var target = e.target instanceof Element ? e.target : null;
    var link = target?.closest("a[href]") as HTMLAnchorElement | null;
    if (link) {
      e.preventDefault();
      if (isAllowedMarkdownLink(link.href)) {
        window.__vscode.postMessage({ type: "openUrl", url: link.href });
      }
    }
    // Close overlays when clicking outside (except the status bar gear)
    if (state.settingsOpen && !state.settingsOverlay.contains(target) && target !== sbSettings && !sbSettings?.contains(target)) {
      closeAllOverlays();
    }
    if (state.capabilitiesOpen && !state.capabilitiesOverlay.contains(target) && target !== sbCapabilities && !sbCapabilities?.contains(target)) {
      closeAllOverlays();
    }
    if (state.userMsgSelectorOpen && !state.userMsgOverlay.contains(target) && target !== state.promptInput) {
      closeAllOverlays();
    }
    if (state.slashAutocompleteOpen && !state.slashAutocomplete.contains(target) && target !== state.promptInput) {
      closeAllOverlays();
    }
    if (state.fileAutocompleteOpen && !state.fileAutocomplete.contains(target) && target !== state.promptInput) {
      closeAllOverlays();
    }
  });

  state.promptInput.addEventListener("keydown", function (e) {
    if (state.fileAutocompleteOpen && e.key === "Tab") {
      e.preventDefault();
      acceptSelectedWorkspaceFile();
      return;
    }
    if (state.fileAutocompleteOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      navigateAutocompleteSelection({
        currentIndex: state.fileSelectedIdx,
        itemCount: state.workspaceFileResults.length + 2,
        direction: e.key === "ArrowDown" ? "next" : "previous",
        container: state.fileAutocomplete,
        renderSelection: function (index) {
          state.fileSelectedIdx = index;
          updateFileAutocomplete();
        },
      });
      return;
    }
    // #8: Tab to accept slash autocomplete
    if (state.slashAutocompleteOpen && e.key === "Tab") {
      e.preventDefault();
      var sel = state.slashAutocomplete.querySelector(".slash-item.selected");
      if (sel) {
        state.promptInput.value = sel.getAttribute("data-cmd") + " ";
        state.promptInput.focus();
      }
      state.slashAutocomplete.classList.remove("visible");
      state.slashAutocompleteOpen = false;
      return;
    }
    // #8: Arrow keys in slash autocomplete
    if (state.slashAutocompleteOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      navigateAutocompleteSelection({
        currentIndex: state.slashSelectedIdx,
        itemCount: getSlashAutocompleteMatches(state.slashFilter).length,
        direction: e.key === "ArrowDown" ? "next" : "previous",
        container: state.slashAutocomplete,
        renderSelection: function (index) {
          state.slashSelectedIdx = index;
          updateSlashAutocomplete(state.slashFilter);
        },
      });
      return;
    }
    // #2: Up arrow in empty input → show user message history
    // Move this BEFORE the slash-autocomplete arrow handling so it takes
    // priority when the input is empty (no slash typed yet)
    if (e.key === "ArrowUp" && state.promptInput.value === "" && state.userMessageHistory.length > 0) {
      e.preventDefault();
      if (!state.userMsgSelectorOpen) {
        showUserMessageSelector();
      } else {
        state.userMsgSelectedIdx = Math.max(0, state.userMsgSelectedIdx - 1);
        highlightUserMsgItem();
      }
      return;
    }
    // ArrowDown: navigate user message list if open
    if (e.key === "ArrowDown" && state.userMsgSelectorOpen) {
      e.preventDefault();
      state.userMsgSelectedIdx = Math.min(state.userMessageHistory.length - 1, state.userMsgSelectedIdx + 1);
      highlightUserMsgItem();
      return;
    }
    // Esc cancels @ file search, or closes any other open overlay.
    if (e.key === "Escape") {
      if (state.fileAutocompleteOpen) {
        e.preventDefault();
        cancelWorkspaceFileAutocomplete();
        return;
      }
      if (state.slashAutocompleteOpen || state.settingsOpen || state.capabilitiesOpen || state.userMsgSelectorOpen) {
        closeAllOverlays();
        e.preventDefault();
        return;
      }
    }
    // Enter: accept user msg or slash autocomplete if open, otherwise send
    if (e.key === "Enter" && !e.shiftKey) {
      if (state.fileAutocompleteOpen) {
        e.preventDefault();
        acceptSelectedWorkspaceFile();
        return;
      }
      if (state.userMsgSelectorOpen) {
        e.preventDefault();
        var idx = state.userMsgSelectedIdx;
        if (idx >= 0 && idx < state.userMessageHistory.length) {
          state.promptInput.value = state.userMessageHistory[idx].text;
          state.promptInput.focus();
          resizePromptInput();
        }
        closeUserMsgSelector();
        return;
      }
      if (state.slashAutocompleteOpen) {
        e.preventDefault();
        var sel = state.slashAutocomplete.querySelector(".slash-item.selected");
        if (sel) {
          state.promptInput.value = sel.getAttribute("data-cmd") + " ";
          resizePromptInput();
        }
        state.slashAutocomplete.classList.remove("visible");
        state.slashAutocompleteOpen = false;
        state.promptInput.focus();
        return;
      }
      closeAllOverlays();
      e.preventDefault();
      // Alt+Enter always queues a follow-up while streaming. Shift+Enter is
      // intentionally left to the textarea for inserting a newline.
      sendPrompt(e.altKey ? "queue" : undefined);
    }
  });

  state.promptInput.addEventListener("input", function () {
    // Save cursor position before height recalculation — setting
    // height:auto then height:Npx can reset selection in VS Code's
    // Chromium, causing garbled text when typing mid-input after
    // using arrow keys to reposition the cursor.
    var selStart = state.promptInput.selectionStart;
    var selEnd = state.promptInput.selectionEnd;

    // Cap at ~5 lines (approx 20px per line = 100px).
    // Only show scrollbar when the content actually exceeds the cap.
    var maxHeight = 100; // 5 lines ~ 100px
    state.promptInput.style.height = "auto";
    var newHeight = Math.min(state.promptInput.scrollHeight, maxHeight);
    state.promptInput.style.height = newHeight + "px";

    // Restore cursor position (height recalculation may have reset it)
    state.promptInput.selectionStart = selStart;
    state.promptInput.selectionEnd = selEnd;
    // Only enable overflow scrollbar when content is truncated
    if (state.promptInput.scrollHeight > maxHeight) {
      state.promptInput.style.overflowY = "auto";
    } else {
      state.promptInput.style.overflowY = "hidden";
    }

    // Detect an @workspace-file mention immediately before the cursor.
    var val = state.promptInput.value;
    var fileMatch = findWorkspaceFileMention(val, state.promptInput.selectionStart);
    if (fileMatch) {
      state.fileMentionStart = fileMatch.start;
      state.fileFilter = fileMatch.query;
      state.fileSelectedIdx = 0;
      state.workspaceFileResults = [];
      state.slashAutocomplete.classList.remove("visible");
      state.slashAutocompleteOpen = false;
      state.fileAutocomplete.innerHTML = '<div class="file-searching">Searching workspace files…</div>';
      state.fileAutocomplete.classList.add("visible");
      state.fileAutocompleteOpen = true;
      window.__vscode.postMessage({ type: "requestWorkspaceFiles", query: state.fileFilter });
    } else {
      state.fileMentionStart = -1;
      state.fileAutocomplete.classList.remove("visible");
      state.fileAutocompleteOpen = false;
      var slashFilter = getSlashCommandFilter(val);
      if (slashFilter !== null) {
        state.slashFilter = slashFilter;
        state.slashSelectedIdx = 0;
        updateSlashAutocomplete(slashFilter);
      } else {
        state.slashAutocomplete.classList.remove("visible");
        state.slashAutocompleteOpen = false;
      }
    }
    updateFollowUpHintVisibility();
  });

export function resizePromptInput(): void {
    var maxHeight = 100;
    state.promptInput.style.height = "auto";
    var newHeight = Math.min(state.promptInput.scrollHeight, maxHeight);
    state.promptInput.style.height = newHeight + "px";
    state.promptInput.style.overflowY = state.promptInput.scrollHeight > maxHeight ? "auto" : "hidden";
    updateFollowUpHintVisibility();
  }

export function handleInsertCommand(command: string) {
    state.promptInput.value = command + " ";
    state.promptInput.focus();
    resizePromptInput();
  }

  // ═══ #1: Compaction Summary Message ═══════════════════════
  // ═══ #1: Compaction Summary Message ═══════════════════════

export function handleCompactionSummaryMessage(data: any) {
    hideWelcome();
    var el = document.createElement("div");
    el.className = "compaction-summary";
    if (data.entryId) {el.id = "entry-" + data.entryId;}
    var tokenStr = (data.tokensBefore || 0).toLocaleString();
    var summaryId = "cs-" + Math.random().toString(36).slice(2, 8);
    el.innerHTML = html`
      <div class="cs-header">[compaction]</div>
      <div class="cs-preview" id="${summaryId}-toggle">Compacted from ${tokenStr} tokens (click to expand)</div>
      <div class="cs-content" id="${summaryId}-content" style="display:none">${data.summary || ""}</div>`;
    state.chatContainer.appendChild(el);

    // Wire toggle
    var toggle = document.getElementById(summaryId + "-toggle");
    var contentEl2 = document.getElementById(summaryId + "-content");
    if (toggle && contentEl2) {
      toggle.addEventListener("click", function () {
      var visible = contentEl2 && contentEl2.style.display !== "none";
      if (contentEl2) { contentEl2.style.display = visible ? "none" : "block"; }
      if (toggle) { toggle.textContent = visible ? "Compacted from " + tokenStr + " tokens (click to expand)" : "Compacted from " + tokenStr + " tokens"; }
      });
    }
    scrollToBottom();
  }

  // ═══ #2: User Message Selector ════════════════════════════

export function handleUserMessagesList(data: any) {
    state.userMessageHistory = (data.messages || []).reverse();
  }

export function showUserMessageSelector() {
    if (state.userMessageHistory.length === 0) {return;}
    closeAllOverlays();
    state.userMsgSelectorOpen = true;
    state.userMsgSelectedIdx = 0;
    state.userMsgOverlay.classList.add("visible");
    var result = "";
    for (var i = 0; i < state.userMessageHistory.length; i++) {
      var msg = state.userMessageHistory[i];
      var text = msg.text || "";
      if (text.length > 100) {text = text.slice(0, 100) + "\u2026";}
      result += html`<div class="user-msg-item" data-idx="${i}"><span class="msg-idx">${i + 1}</span>${text}</div>`;
    }
    state.userMsgOverlay.innerHTML = result;

    // Click handlers
    var items = state.userMsgOverlay.querySelectorAll(".user-msg-item");
    items.forEach(function (item) {
      item.addEventListener("click", function (this: HTMLElement) {
        var idx = parseInt(this.getAttribute("data-idx") || "0", 10);
        if (idx >= 0 && idx < state.userMessageHistory.length) {
          var text = state.userMessageHistory[idx].text;
          state.promptInput.value = text;
          state.promptInput.focus();
          resizePromptInput();
        }
        closeUserMsgSelector();
      });
    });
  }

export function highlightUserMsgItem() {
    var items = state.userMsgOverlay.querySelectorAll(".user-msg-item");
    items.forEach(function (item: any, i: number) {
      if (i === state.userMsgSelectedIdx) {
        item.classList.add("selected");
        item.scrollIntoView({ block: "nearest" });
      } else {
        item.classList.remove("selected");
      }
    });
  }

export function closeUserMsgSelector() {
    state.userMsgSelectorOpen = false;
    state.userMsgSelectedIdx = 0;
    state.userMsgOverlay.classList.remove("visible");
  }

  // ═══ Capabilities Panel ═════════════════════════════════

export function handleCapabilitiesPanelUpdate(data: any) {
    state.capabilitiesState = {
      loading: data?.loading === true,
      error: typeof data?.error === "string" ? data.error : undefined,
      capabilities: Array.isArray(data?.capabilities) ? data.capabilities : [],
    };
    renderCapabilitiesPanel();
  }

export function renderCapabilitiesPanel() {
    if (!state.capabilitiesOverlay || !state.capabilitiesOpen) { return; }
    const panelState = state.capabilitiesState;
    let result = html`<div class="extensions-title-row">
      <div class="extensions-title">Capabilities</div>
      <button class="extensions-refresh" type="button" title="Reload extensions, skills, and context">↻</button>
    </div>`;

    if (panelState.loading) {
      result += '<div class="extensions-empty">Reloading capabilities...</div>';
    } else if (panelState.error) {
      result += html`<div class="extensions-error">${panelState.error}</div>`;
    } else if (panelState.capabilities.length === 0) {
      result += '<div class="extensions-empty">No capabilities are available in this session.</div>';
    } else {
      for (const kind of ["skill", "extension"] as const) {
        const capabilities = panelState.capabilities.filter((item) => item.kind === kind);
        if (capabilities.length === 0) { continue; }
        result += html`<div class="capabilities-section-title">${kind === "skill" ? "Skills" : "Extensions"}</div>`;
        for (const capability of capabilities) {
          result += html`<div class="extensions-row capability-${capability.kind}">
            <div class="extensions-info" title="${capability.path}">
              <a class="extensions-name capability-name-link" href="#" data-capability-path="${capability.path}">${capability.name}</a>
              <div class="extensions-meta">${capability.kind === "extension" ? `${capability.scope} · ${capability.origin}` : ""}</div>
            </div>
            <button class="extensions-toggle${capability.enabled ? " on" : ""}"
              type="button" data-kind="${capability.kind}" data-path="${capability.path}"
              data-enabled="${capability.enabled ? "true" : "false"}"
              aria-label="${capability.enabled ? "Disable" : "Enable"} ${capability.name}"
              aria-pressed="${capability.enabled ? "true" : "false"}"></button>
          </div>`;
        }
      }
    }

    state.capabilitiesOverlay.innerHTML = result;
    state.capabilitiesOverlay.querySelector(".extensions-refresh")?.addEventListener("click", function (event) {
      event.stopPropagation();
      window.__vscode.postMessage({ type: "reloadCapabilities" });
    });
    state.capabilitiesOverlay.querySelectorAll(".capability-name-link").forEach(function (link) {
      link.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        const capabilityPath = link.getAttribute("data-capability-path");
        if (capabilityPath) {
          window.__vscode.postMessage({ type: "openFile", path: capabilityPath });
        }
      });
    });
    state.capabilitiesOverlay.querySelectorAll(".extensions-toggle").forEach(function (toggle) {
      toggle.addEventListener("click", function (event) {
        event.stopPropagation();
        const kind = toggle.getAttribute("data-kind");
        const capabilityPath = toggle.getAttribute("data-path");
        const currentlyEnabled = toggle.getAttribute("data-enabled") === "true";
        if ((kind !== "skill" && kind !== "extension") || !capabilityPath) { return; }
        window.__vscode.postMessage({
          type: "setCapabilityEnabled",
          kind,
          path: capabilityPath,
          enabled: !currentlyEnabled,
        });
      });
    });
  }

export function toggleCapabilitiesPanel() {
    if (state.capabilitiesOpen) {
      closeAllOverlays();
      return;
    }
    closeAllOverlays();
    state.capabilitiesOpen = true;
    state.capabilitiesOverlay.classList.add("visible");
    renderCapabilitiesPanel();
    window.__vscode.postMessage({ type: "getCapabilities" });
  }

  // ═══ #3: Settings Panel ═══════════════════════════════════

export function handleSettingsUpdate(data: any) {
    if (data) {
      const wasAutoAttachEnabled = state.settingsState.autoAttachActiveEditor;
      state.settingsState = data;
      if (!wasAutoAttachEnabled && data.autoAttachActiveEditor === true) {
        state.dismissedEditorContextIds = {};
      }
      document.body.classList.toggle("hide-message-images", data.showImages === false);
      if (data.autoCollapseToolResults === false) {
        document.querySelectorAll<HTMLElement>(".tool-block, .bash-execution").forEach((el) => {
          applyAutoToolResultCollapse(el);
        });
      }
      renderSettingsPanel();
      renderAttachments();
    }
  }

export function handleScopedModelsUpdate(data: any) {
    if (data && data.models) {
      state.scopedModels = data.models;
      renderScopedModels();
      renderSettingsPanel();
    }
  }

export function renderScopedModels() {
    // Scoped models removed from UI
  }

export function renderSettingsPanel() {
    if (!state.settingsOverlay || !state.settingsOpen) {return;}
    var result = '<div class="settings-title">Settings</div>';

    var toggles = [
      { key: "autoCompaction", label: "Auto-compaction" },
      { key: "autoRetry", label: "Auto-retry" },
      { key: "showImages", label: "Show images" },
      { key: "autoCollapseToolResults", label: "Auto-collapse tool results" },
      { key: "autoAttachActiveEditor", label: "Auto-attach active file" },
    ];

    for (var i = 0; i < toggles.length; i++) {
      var t = toggles[i];
      var on = (state.settingsState as Record<string, boolean>)[t.key];
      result += html`
        <div class="settings-row">
          <span>${t.label}</span>
          <span class="settings-toggle${on ? " on" : ""}" data-key="${t.key}"></span>
        </div>`;
    }

    state.settingsOverlay.innerHTML = result;

    // Wire toggle clicks
    var togglesEls = state.settingsOverlay.querySelectorAll(".settings-toggle");
    togglesEls.forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.stopPropagation();
        var key = el.getAttribute("data-key");
        if (key === "autoCompaction") { window.__vscode.postMessage({ type: "toggleAutoCompaction" }); }
        else if (key === "autoRetry") { window.__vscode.postMessage({ type: "toggleAutoRetry" }); }
        else if (key === "showImages") { window.__vscode.postMessage({ type: "toggleShowImages" }); }
        else if (key === "autoCollapseToolResults") { window.__vscode.postMessage({ type: "toggleAutoCollapseToolResults" }); }
        else if (key === "autoAttachActiveEditor") {
          window.__vscode.postMessage({ type: "toggleAutoAttachActiveEditor" });
        }
      });
    });
  }

export function toggleSettingsPanel() {
    if (state.settingsOpen) {
      closeAllOverlays();
    } else {
      closeAllOverlays();
      state.settingsOpen = true;
      state.settingsOverlay.classList.add("visible");
      window.__vscode.postMessage({ type: "getSettings" });
    }
  }

export function closeAllOverlays() {
    state.settingsOpen = false;
    state.capabilitiesOpen = false;
    state.userMsgSelectorOpen = false;
    state.slashAutocompleteOpen = false;
    state.fileAutocompleteOpen = false;
    state.fileMentionStart = -1;
    state.settingsOverlay.classList.remove("visible");
    state.capabilitiesOverlay.classList.remove("visible");
    state.userMsgOverlay.classList.remove("visible");
    state.slashAutocomplete.classList.remove("visible");
    state.fileAutocomplete.classList.remove("visible");
  }

  // ═══ #5: Diff Rendering for edit tool results ════════════
  // ═══ #7: Custom Message Rendering ═════════════════════════

/**
 * Render a custom message inline in the conversation stream.
 * Supports per-customType renderers registered via
 * window.__piRegisterMessageRenderer, and updates existing
 * cards in-place when the same customType reappears (polling).
 * Action buttons with data-command execute slash commands.
 */
export function renderInlineCustomMessage(data: any) {
    var customType = data.customType || "custom";
    var content = typeof data.content === "string"
      ? data.content
      : (Array.isArray(data.content) ? data.content.filter(function (c: any) { return c.type === "text"; }).map(function (c: any) { return c.text; }).join("\n") : "");

    // Check for existing card to update in-place (polling refresh)
    var existing = state.chatContainer.querySelector('[data-custom-type="' + customType + '"]');
    var renderer = getMessageRenderer(customType);

    if (existing) {
      var existingIc = existing._component as any;
      if (existingIc) {
        existingIc.update({
          customType: customType,
          content: renderMarkdown(content),
          renderer: renderer,
          rawData: data,
          escapeHtmlFn: escapeHtml,
        });
      } else if (renderer) {
        var body = existing.querySelector(".custom-message-body");
        var bodyEl = existing.querySelector(".custom-message-body") as HTMLElement;
        if (bodyEl) { bodyEl.innerHTML = ""; renderer(data, bodyEl, escapeHtml); }
      } else {
        (existing.querySelector(".custom-message-body") as HTMLElement).innerHTML = renderMarkdown(content);
      }
      return;
    }

    // Create new inline card
    var ic = new InlineCard({
      customType: customType,
      content: renderMarkdown(content),
      renderer: renderer,
      rawData: data,
      escapeHtmlFn: escapeHtml,
    });
    ic.el._component = ic; // attach for later updating

    state.chatContainer.appendChild(ic.el as HTMLElement);
    scrollToBottom();
  }

export function handleCustomMessage(data: any) {
    var customType = data.customType || "custom";

    // ── display: true → inline in conversation stream ──────
    if (data.display === true) {
      hideWelcome();
      renderInlineCustomMessage(data);
      return;
    }

    // "info" type: render as in-chat status message (for slash command feedback)
    if (customType === "info") {
      var infoContent = "";
      if (typeof data.content === "string") {
        infoContent = data.content;
      } else if (Array.isArray(data.content)) {
        infoContent = data.content.filter(function (c: any) { return c.type === "text"; }).map(function (c: any) { return c.text; }).join("\n");
      }
      if (infoContent) {
        hideWelcome();
        var infoEl = document.createElement("div");
        infoEl.className = "message assistant";
        infoEl.innerHTML = html`<div class="message-content muted">${infoContent}</div>`;
        state.chatContainer.appendChild(infoEl);
        scrollToBottom();
      }
      return;
    }

    // Try the registry first — extensions can register custom renderers
    var renderer = getMessageRenderer(customType);
    if (renderer) {
      renderer(data, state.livePanel, state.liveCards, createLiveCard, dismissLiveCard);
      return;
    }

    // Fall back to the default live-card renderer
    defaultMessageRenderer(data);
  }

export function dismissLiveCard(key: string) {
    var card = state.liveCards[key as string];
    if (card) {
      card.remove();
      delete state.liveCards[key as string];
    }
    var widgetCard = state.widgetCards[key];
    if (widgetCard) {
      widgetCard.remove();
      delete state.widgetCards[key];
    }
    // Hide panel if empty
    var remaining = state.livePanel.querySelectorAll(".live-card");
    if (remaining.length === 0) {
      state.livePanel.classList.remove("visible");
    }
  }

export function clearLivePanel(): void {
    // Only clear transient cards (non-widget cards).
    // Widget cards persist until the extension explicitly clears them.
    var toRemove = [];
    for (var key in state.liveCards) {
      if (state.liveCards.hasOwnProperty(key)) {
        var card = state.liveCards[key as string];
        if (card && card.getAttribute("data-widget") !== "true") {
          toRemove.push(key);
        }
      }
    }
    for (var i = 0; i < toRemove.length; i++) {
      var c = state.liveCards[toRemove[i]];
      if (c) {c.remove();}
      delete state.liveCards[toRemove[i]];
    }
    // Hide the panel if nothing remains
    var remaining = state.livePanel.querySelectorAll(".live-card");
    if (remaining.length === 0) {
      state.livePanel.classList.remove("visible");
    }
  }

  // ── Widget Bridge ─────────────────────────────────────
  // ── Widget Bridge ─────────────────────────────────────


/** Bridge: extension host registers a renderer by source code. */
export function handleRegisterMessageRenderer(data: any) {
    if (!data.customType || !data.sourceCode) {return;}
    try {
      // CSP blocks eval().  Inject a <script nonce> tag instead.
      var nonce = (document.querySelector("script[nonce]") as HTMLScriptElement | null)?.getAttribute("nonce");
      if (!nonce) {
        console.warn("[pi-on-code] Cannot register renderer: no CSP nonce found");
        return;
      }
      var fnName = "__piRenderer_" + data.customType.replace(/[^\w]/g, "_");
      var script = document.createElement("script");
      script.setAttribute("nonce", nonce);
      script.textContent =
        "window['" + fnName + "'] = function(data, containerEl, escapeHtml) { " + data.sourceCode + " }";
      document.head.appendChild(script);
      var renderer = (window as any)[fnName];
      if (typeof renderer === "function") {
        var boundRenderer = function(d: any, el: HTMLElement) {
          renderer(d, el, escapeHtml);
        };
        registerMessageRenderer(data.customType, boundRenderer);
      }
    } catch (e) {
      console.warn("[pi-on-code] Failed to register message renderer for", data.customType, e);
    }
  }

export function handleWidgetUpdate(data: any) {
    if (!data || !data.key) {return;}

    var key = data.key;
    var content = data.content;

    // ── status-* widgets render inline in the status bar, not as live cards ──
    if (key.startsWith("status-")) {
      handleStatusWidget(key, content);
      return;
    }

    if (content === null || content === undefined) {
      // Remove widget card
      var existing = state.widgetCards[key];
      if (existing) {
        existing.remove();
        delete state.widgetCards[key];
      }
      // Also remove from state.liveCards
      delete state.liveCards[key as string];
      // Hide panel if empty
      var remaining = state.livePanel.querySelectorAll(".live-card");
      if (remaining.length === 0) {
        state.livePanel.classList.remove("visible");
      }
      return;
    }

    // Create or update widget card
    var card = state.widgetCards[key];
    if (card) {
      (card as HTMLElement).querySelector(".live-card-content")!.innerHTML = renderMarkdown(content);
    } else {
      card = document.createElement("div");
      card.className = "live-card";
      card.setAttribute("data-widget", "true");
      card.setAttribute("data-type", key);
      card.innerHTML = html`
        <div class="live-card-label">${key}</div>
        <button class="live-card-close" title="Dismiss">&times;</button>
        <div class="live-card-content">${safe(renderMarkdown(content))}</div>`;
      (card as HTMLElement).querySelector(".live-card-close")!.addEventListener("click", function () {
        dismissLiveCard(key);
      });
      state.livePanel.appendChild(card);
      state.widgetCards[key] = card;
      state.liveCards[key as string] = card;
    }
    state.livePanel.classList.add("visible");
  }

/** Render a status-* widget as an inline indicator in the status bar. */
export function handleStatusWidget(key: string, content: string | null) {
    var statusBar = document.getElementById("pi-extension-status");
    if (!statusBar) {return;}

    if (content === null || content === undefined) {
      // Remove status indicator
      var existingStatus = statusBar.querySelector('[data-status-key="' + key + '"]');
      if (existingStatus) {(existingStatus as HTMLElement).remove();}
      // Also clean up any legacy live-card
      var legacy = state.widgetCards[key];
      if (legacy) {(legacy as HTMLElement).remove(); delete state.widgetCards[key];}
      delete state.liveCards[key as string];
      return;
    }

    // Parse markdown content: **key** value → bold key + value
    var displayText = content;
    var match = content.match(/^\*\*(.+?)\*\*\s*(.*)/);
    var label = match ? match[1] : key;
    var value = match ? match[2] : content;

    var existingEl = statusBar.querySelector('[data-status-key="' + key + '"]');
    if (existingEl) {
      existingEl.textContent = label + ": " + value;
    } else {
      var span = document.createElement("span");
      span.className = "pi-extension-status-item";
      span.setAttribute("data-status-key", key);
      span.textContent = label + ": " + value;
      statusBar.appendChild(span);
    }

    // Clean up any legacy live-card
    var legacy = state.widgetCards[key];
    if (legacy) {(legacy as HTMLElement).remove(); delete state.widgetCards[key];}
    delete state.liveCards[key as string];
  }

export function clearWidgetCards() {
    for (var key in state.widgetCards) {
      if (state.widgetCards.hasOwnProperty(key)) {
        state.widgetCards[key].remove();
      }
    }
    state.widgetCards = {};
  }

  // ═══ Focused custom TUI bridge ═══════════════════════════

const customUis = new Map<string, CustomUi>();

export function handleCustomUiOpen(data: any): void {
    if (!data?.id || !Array.isArray(data.lines)) { return; }
    const existing = customUis.get(data.id);
    if (existing) {
      existing.update(data);
      return;
    }
    const customUi = new CustomUi(data);
    customUis.set(data.id, customUi);
    customUi.mount();
  }

export function handleCustomUiUpdate(data: any): void {
    if (!data?.id || !Array.isArray(data.lines)) { return; }
    customUis.get(data.id)?.update(data);
  }

export function handleCustomUiClose(data: any): void {
    if (!data?.id) { return; }
    const customUi = customUis.get(data.id);
    if (!customUi) { return; }
    customUi.destroy();
    customUis.delete(data.id);
    state.promptInput.focus();
  }

  // ═══ Interactive Dialog Bridge ═══════════════════════════

let pendingCustomAnswer: {
  dialog: Dialog;
  questionStem: string;
  answer: string;
} | null = null;

function postExtensionUIResponse(id: string, value: unknown): void {
  window.__vscode.postMessage({ type: "extension_ui_response", id, value });
}

export function handleShowDialog(data: any) {
    if (!data || !data.id) {return;}

    // rpiv-ask-user-question's RPC fallback follows its custom sentinel with
    // a separate input() request. Resolve that request invisibly because the
    // original inline card already collected the text and should be the only
    // question card shown in the transcript.
    if (
      pendingCustomAnswer &&
      data.dialogType === "input" &&
      dialogQuestionStem(data.prompt || "") === pendingCustomAnswer.questionStem
    ) {
      const pending = pendingCustomAnswer;
      pendingCustomAnswer = null;
      pending.dialog.completeCustomAnswer(pending.answer);
      postExtensionUIResponse(data.id, pending.answer);
      scrollToBottom();
      return;
    }

    hideWelcome();
    var dlg = new Dialog({
      dialogType: data.dialogType || "confirm",
      id: data.id,
      prompt: data.prompt || "",
      options: data.options || [],
      defaultValue: data.defaultValue || "",
      onCustomSubmit: (selection, answer) => {
        pendingCustomAnswer = {
          dialog: dlg,
          questionStem: dialogQuestionStem(data.prompt || ""),
          answer,
        };
        // First satisfy select(); the package will immediately issue input(),
        // which the branch above resolves using the text from this same card.
        postExtensionUIResponse(data.id, selection);
      },
    });
    // Extension questions belong to the transcript. Keep completed cards in
    // place so both the prompt and the chosen answer retain conversation order.
    dlg.mount(state.chatContainer);
    scrollToBottom();
  }

  // ═══ #8: Slash Command Autocomplete ═══════════════════════
  // ═══ #8: Slash Command Autocomplete ═══════════════════════

  // Built-in slash commands (always available)

  // Dynamic slash commands populated from installed extensions (e.g. /tldr)

export function addWorkspaceFileAttachment(item: {
    id: string;
    path: string;
    name: string;
    kind?: "file" | "folder";
    external?: boolean;
  }): void {
    if (!state.workspaceFileAttachments.some(function (attached) { return attached.id === item.id; }) &&
        state.workspaceFileAttachments.length < 20) {
      state.workspaceFileAttachments.push(item);
      renderAttachments();
    }
  }

export function cancelWorkspaceFileAutocomplete(): void {
    var updated = removeWorkspaceFileMention(
      state.promptInput.value,
      state.fileMentionStart,
      state.promptInput.selectionStart,
    );
    state.fileMentionStart = -1;
    state.fileFilter = "";
    state.workspaceFileResults = [];
    state.fileAutocomplete.classList.remove("visible");
    state.fileAutocompleteOpen = false;
    state.promptInput.value = updated.text;
    state.promptInput.selectionStart = state.promptInput.selectionEnd = updated.cursor;
    state.promptInput.dispatchEvent(new Event("input"));
    state.promptInput.focus();
  }

export function acceptWorkspaceFile(item: {
    id: string;
    path: string;
    name: string;
    kind?: "file" | "folder";
    external?: boolean;
  }): void {
    addWorkspaceFileAttachment(item);

    var cursor = state.promptInput.selectionStart;
    if (state.fileMentionStart >= 0 && state.fileMentionStart <= cursor) {
      var updated = removeWorkspaceFileMention(
        state.promptInput.value,
        state.fileMentionStart,
        cursor,
      );
      state.promptInput.value = updated.text;
      state.promptInput.selectionStart = state.promptInput.selectionEnd = updated.cursor;
      state.promptInput.dispatchEvent(new Event("input"));
    }
    state.fileAutocomplete.classList.remove("visible");
    state.fileAutocompleteOpen = false;
    state.workspaceFileResults = [];
    state.promptInput.focus();
  }

export function acceptSelectedWorkspaceFile(): void {
    if (state.fileSelectedIdx === 0 || state.fileSelectedIdx === 1) {
      const kind = state.fileSelectedIdx === 0 ? "file" : "folder";
      cancelWorkspaceFileAutocomplete();
      window.__vscode.postMessage({ type: "browseContextAttachments", kind });
      return;
    }
    const item = state.workspaceFileResults[state.fileSelectedIdx - 2];
    if (item) { acceptWorkspaceFile(item); }
  }

export function handleWorkspaceFilesUpdate(data: any): void {
    if (state.fileMentionStart < 0 || !data || data.query !== state.fileFilter || !Array.isArray(data.items)) { return; }
    state.workspaceFileResults = data.items.filter(function (item: any) {
      return !state.workspaceFileAttachments.some(function (attached) {
        return attached.id === item.id;
      });
    });
    state.fileSelectedIdx = Math.min(
      state.fileSelectedIdx,
      state.workspaceFileResults.length + 1,
    );
    updateFileAutocomplete();
  }

export function updateFileAutocomplete(): void {
    state.fileSelectedIdx = Math.min(
      state.fileSelectedIdx,
      state.workspaceFileResults.length + 1,
    );
    var result = html`
      <div class="file-item file-browse-item${state.fileSelectedIdx === 0 ? " selected" : ""}" data-browse-kind="file">
        <span class="file-name">Browse files…</span>
        <span class="file-path">Select files inside or outside the workspace</span>
      </div>
      <div class="file-item file-browse-item${state.fileSelectedIdx === 1 ? " selected" : ""}" data-browse-kind="folder">
        <span class="file-name">Browse folder…</span>
        <span class="file-path">Attach its path and file listing only</span>
      </div>`;
    for (var i = 0; i < state.workspaceFileResults.length; i++) {
      var item = state.workspaceFileResults[i];
      result += html`
        <div class="file-item${i + 2 === state.fileSelectedIdx ? " selected" : ""}" data-file-id="${item.id}">
          <span class="file-name">${item.source === "session" ? "session: " : ""}${item.name}</span>
          <span class="file-path">${item.path}</span>
        </div>`;
    }
    state.fileAutocomplete.innerHTML = result;
    state.fileAutocomplete.classList.add("visible");
    state.fileAutocompleteOpen = true;

    state.fileAutocomplete.querySelectorAll("[data-browse-kind]").forEach(function (element) {
      element.addEventListener("click", function () {
        const kind = element.getAttribute("data-browse-kind");
        if (kind !== "file" && kind !== "folder") { return; }
        cancelWorkspaceFileAutocomplete();
        window.__vscode.postMessage({ type: "browseContextAttachments", kind });
      });
    });
    state.fileAutocomplete.querySelectorAll(".file-item[data-file-id]").forEach(function (element) {
      element.addEventListener("click", function () {
        var id = element.getAttribute("data-file-id");
        var item = state.workspaceFileResults.find(function (candidate) { return candidate.id === id; });
        if (item) { acceptWorkspaceFile(item); }
      });
    });
  }

  // Full slash command list (builtins + extensions, with extensions first for dedup)
export function getSlashCommands() {
    // When the extension host has pushed a complete slash-command list
    // (extension + builtin + prompt templates), use it directly.
    if (state.extensionSlashCommands.length > 0) {
      return state.extensionSlashCommands;
    }
    // Fallback: use hardcoded builtins (before first slash-commands-update arrives)
    return state.builtinSlashCommands;
  }

  // Slash commands that should be handled locally (not sent to LLM)

export function handleSlashCommandsUpdate(data: any) {
    if (data && data.commands && Array.isArray(data.commands)) {
      state.extensionSlashCommands = data.commands;
      // Re-filter autocomplete if it's currently open
      if (state.slashAutocompleteOpen) {
        updateSlashAutocomplete(state.slashFilter);
      }
    }
  }

export function getSlashAutocompleteMatches(filter: string) {
    if (!filter) { return []; }
    return filterSlashCommands(getSlashCommands(), filter);
  }

export function updateSlashAutocomplete(filter: string) {
    if (!filter || filter.length === 0) {
      state.slashAutocomplete.classList.remove("visible");
      state.slashAutocompleteOpen = false;
      return;
    }
    var matches = getSlashAutocompleteMatches(filter);
    if (matches.length === 0) {
      state.slashAutocomplete.classList.remove("visible");
      state.slashAutocompleteOpen = false;
      return;
    }
    state.slashAutocomplete.classList.add("visible");
    state.slashAutocompleteOpen = true;
    state.slashSelectedIdx = Math.min(state.slashSelectedIdx, matches.length - 1);

    var result = "";
    for (var i = 0; i < matches.length; i++) {
      var sc = matches[i];
      var scopeLabel = sc.scope === "user" ? "[u]" : sc.scope === "project" ? "[p]" : sc.scope === "temporary" ? "[t]" : "";
      var sourceLabel = [scopeLabel, sc.source].filter(Boolean).join(" ");
      result += html`
        <div class="slash-item${i === state.slashSelectedIdx ? " selected" : ""}" data-index="${i}" data-cmd="${sc.cmd}">
          <span class="slash-cmd">${sc.cmd}</span>
          ${renderSlashSourceLabel(sourceLabel)}
          <span class="slash-desc">${sc.desc}</span>
        </div>`;
    }
    state.slashAutocomplete.innerHTML = result;

    // Wire click handlers
    var items = state.slashAutocomplete.querySelectorAll(".slash-item");
    items.forEach(function (item) {
      item.addEventListener("click", function (this: HTMLElement) {
        var cmd = item.getAttribute("data-cmd");
        if (cmd) {
          state.promptInput.value = cmd + " ";
          state.promptInput.focus();
          resizePromptInput();
        }
        state.slashAutocomplete.classList.remove("visible");
        state.slashAutocompleteOpen = false;
      });
    });
  }

  // ═══ #9: Scroll-to-entry ═══════════════════════════════════
  // ═══ #9: Scroll-to-entry ═══════════════════════════════════

export function handleRevealEntry(entryId: string, toolCallId: string, waitFrames = 0) {
    if (!entryId && !toolCallId) {return;}
    if (state.historyLoading && waitFrames < 10) {
      requestAnimationFrame(function () {
        handleRevealEntry(entryId, toolCallId, waitFrames + 1);
      });
      return;
    }
    var el: HTMLElement | null = null;

    // Strategy 1: exact ID match (entry-{id}, tool-{id}, bash-{id})
    if (entryId) {
      var prefixes = ["entry-", "tool-", "bash-"];
      for (var pi = 0; pi < prefixes.length; pi++) {
        el = document.getElementById(prefixes[pi] + entryId);
        if (el) {break;}
      }
    }

    // Strategy 2: search by data-entry-id (the entry UUID)
    if (!el && entryId) {
      el = document.querySelector('[data-entry-id="' + entryId + '"]');
    }

    // Strategy 3: search by data-tool-call-id (the SDK tool call ID)
    // Use entryId first, then toolCallId if provided
    if (!el && entryId) {
      el = document.querySelector('[data-tool-call-id="' + entryId + '"]');
    }
    if (!el && toolCallId) {
      el = document.querySelector('[data-tool-call-id="' + toolCallId + '"]');
    }

    // Strategy 4: loose match — any element whose ID contains the entryId or toolCallId
    if (!el) {
      var searchStr = entryId || toolCallId;
      if (searchStr) {
        var allWithId = document.querySelectorAll("[id]");
        for (var ai = 0; ai < allWithId.length; ai++) {
          if (allWithId[ai].id.indexOf(searchStr) !== -1) {
            el = allWithId[ai];
            break;
          }
        }
      }
    }

    if (!el) {return;}

    (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "center" });
    (el as HTMLElement).style.transition = "background 0.2s, box-shadow 0.2s";
    (el as HTMLElement).style.background = "var(--vscode-list-hoverBackground)";
    (el as HTMLElement).style.boxShadow = "0 0 0 2px var(--vscode-focusBorder)";
    (el as HTMLElement).style.borderRadius = "4px";
    setTimeout(function () {
      (el as HTMLElement).style.background = "";
      (el as HTMLElement).style.boxShadow = "";
      (el as HTMLElement).style.borderRadius = "";
    }, 2500);
  }

  // ═══ #10: Bash Execution Blocks ════════════════════════════
  // ═══ #10: Bash Execution Blocks ════════════════════════════
  //
  // These dedicated bash handlers exist for backward compatibility
  // with the extension host's bash-* event stream.  They delegate
  // to the bash tool renderer registered in the tool renderer registry.

export function handleBashStart(data: Record<string, unknown>) {
    // Stop thinking spinner — bash execution means thinking is done
    if (state.currentThinkingEl) {
      var _tb3 = state.currentThinkingEl._component as any;
      if (_tb3) {
        _tb3.update({ content: _tb3._rawText || "", done: true });
      } else {
        var thSpinner = state.currentThinkingEl.querySelector(".thinking-spinner");
        if (thSpinner) {thSpinner.remove();}
      }
    }

    var callId = data.toolCallId;

    // DEDUP: If tool-start already created a block for this callId, don't create a second.
    if (state.currentToolBlocks[callId as string]) {
      var entry = state.currentToolBlocks[callId as string];
      state.bashBlocks[callId as string] = (entry as any).el || entry;
      state.bashOutputs[callId as string] = state.bashOutputs[callId as string] || "";
      return;
    }
    if (state.bashBlocks[callId as string]) {return;}

    var block = bashToolRenderer.create({
      toolName: "bash",
      toolCallId: callId as string,
      args: { command: data.command || "" },
      entryId: data.entryId as string,
      fromMessage: false,
    });
    applyAutoToolResultCollapse(block as HTMLElement);
    insertToolBlock(block as HTMLElement);
    state.bashBlocks[callId as string] = block;
    state.bashOutputs[callId as string] = "";
    scrollToBottom();
  }

export function handleBashOutput(data: Record<string, unknown>) {
    var callId = data.toolCallId;
    var block = state.bashBlocks[callId as string];
    if (!block) {
      var entry = state.currentToolBlocks[callId as string];
      block = entry ? ((entry as any).el || entry) : null;
      if (!block) {return;}
    }
    state.bashOutputs[callId as string] = (state.bashOutputs[callId as string] || "") + (data.output || "");
    var outEl = block.querySelector(".bash-output");
    if (outEl) {
      morphRender(outEl, escapeHtml(state.bashOutputs[callId as string]));
      outEl.scrollTop = outEl.scrollHeight;
    }
    scrollToBottom();
  }

export function handleBashEnd(data: Record<string, unknown>) {
    var callId = data.toolCallId;
    var block = state.bashBlocks[callId as string];
    if (!block) {
      var entry = state.currentToolBlocks[callId as string];
      block = entry ? ((entry as any).el || entry) : null;
      if (!block) {return;}
    }
    var result = {
      content: data.output ? [{ type: "text", text: data.output }] : [],
      details: { exitCode: data.exitCode, cancelled: data.cancelled },
    };
    bashToolRenderer.finalize(block as any, result as any, data.isError as boolean, data.entryId as any);
    addToolOutputCopyButton(block as HTMLElement, result as any);
    delete state.currentToolBlocks[callId as string];
    delete state.bashBlocks[callId as string];
    delete state.bashOutputs[callId as string];
    scrollToBottom();
  }

  // ═══ /debug command ═════════════════════════════════════
  // ═══ /debug command ═════════════════════════════════════
  //
  // Renders the current webview state as a collapsible message in chat.
  // No copy-paste needed — it appears inline with:
  //   • Chat DOM structure summary (tags, IDs, statuses — no text content)
  //   • Bash block tracker state
  //   • Tool block tracker state
  //   • Last 20 events received
  //   • Last 20 DOM mutations
  //   • Duplicate / orphan analysis
  //
  // Also dumps the same data to console.log for DevTools inspection.

export function handleDebugCommand(): void {
    hideWelcome();
    var summary = window.__piDebug.summary() as { chat: any; dupes: string[]; orphanBash: string[]; orphanTool: string[]; lastEvents: any[]; lastDomChanges: any[] };

    // Build full text for clipboard copy + console dump
    var copyText = "Pi Code GUI — Debug Dump\n" +
      "==========================\n\n" +
      "Chat Container:\n" + JSON.stringify(summary.chat, null, 2) + "\n\n" +
      "Tracker State:\n" +
      "state.bashBlocks: " + JSON.stringify(Object.keys(state.bashBlocks)) + "\n" +
      "state.currentToolBlocks: " + JSON.stringify(Object.keys(state.currentToolBlocks)) + "\n" +
      "state.bashOutputs: " + JSON.stringify(Object.keys(state.bashOutputs)) + "\n" +
      "Duplicates: " + JSON.stringify(summary.dupes) + "\n" +
      "Orphan bash: " + JSON.stringify(summary.orphanBash) + "\n" +
      "Orphan tool: " + JSON.stringify(summary.orphanTool) + "\n\n" +
      "Last 20 Events:\n" + JSON.stringify(summary.lastEvents, null, 2) + "\n\n" +
      "Follow-up / Steer State:\n" +
      "state.isStreaming: " + state.isStreaming + "\n" +
      "state.queueMode: " + state.queueMode + "\n" +
      "pending-queue-indicator exists: " + !!document.getElementById("pending-queue-indicator") + "\n" +
      "queue events (" + ((window.__piDebug._queueEvents || []).length) + "): " + JSON.stringify((window.__piDebug._queueEvents || []).slice(-10), null, 2) + "\n\n" +
      "Last 20 DOM Mutations:\n" + JSON.stringify(summary.lastDomChanges, null, 2) + "\n";

    // Also log to console so DevTools users can inspect without copy-paste
    console.log("[pi-debug] === Webview State Dump ===");
    console.log(copyText);

    var el = document.createElement("div");
    el.className = "message assistant";

    el.innerHTML =
      '<div class="message-content">' +
      '<details class="thinking-block" open>' +
      '<summary>🔍 Debug: Webview State ' +
      '<button class="debug-copy-all-btn" type="button" title="Copy all debug output">📋 Copy All</button>' +
      '</summary>' +
      '<div class="debug-output">' +

      '<h4>Chat Container</h4>' +
      '<pre>' +
      escapeHtml(JSON.stringify(summary.chat, null, 2)) +
      '</pre>' +

      '<h4>Tracker State</h4>' +
      '<pre>' +
      'state.bashBlocks: ' + JSON.stringify(Object.keys(state.bashBlocks)) + '\n' +
      'state.currentToolBlocks: ' + JSON.stringify(Object.keys(state.currentToolBlocks)) + '\n' +
      'state.bashOutputs: ' + JSON.stringify(Object.keys(state.bashOutputs)) + '\n' +
      'Duplicates: ' + JSON.stringify(summary.dupes) + '\n' +
      'Orphan bash: ' + JSON.stringify(summary.orphanBash) + '\n' +
      'Orphan tool: ' + JSON.stringify(summary.orphanTool) +
      '</pre>' +

      '<h4>Last 20 Events</h4>' +
      '<pre class="scrollable">' +
      escapeHtml(JSON.stringify(summary.lastEvents, null, 2)) +
      '</pre>' +

      '<h4>Follow-up / Steer State</h4>' +
      '<pre>' +
      'state.isStreaming: ' + state.isStreaming + '\n' +
      'state.queueMode: ' + state.queueMode + '\n' +
      'pending-queue-indicator exists: ' + !!document.getElementById("pending-queue-indicator") + '\n' +
      'queue events (' + ((window.__piDebug._queueEvents || []).length) + '): ' + JSON.stringify((window.__piDebug._queueEvents || []).slice(-10), null, 2) + '\n' +
      '</pre>' +

      '<h4>Last 20 DOM Mutations</h4>' +
      '<pre class="scrollable">' +
      escapeHtml(JSON.stringify(summary.lastDomChanges, null, 2)) +
      '</pre>' +

      '<p class=\"debug-tip\">' +
      'Tip: <code>window.__piDebug.summary()</code> in DevTools, or <code>/debug</code> again.' +
      '</p>' +

      '</div>' +
      '</details>' +
      '</div>';

    // Wire Copy All button
    var copyBtn = el.querySelector(".debug-copy-all-btn");
    if (copyBtn!) {
      copyBtn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation(); // don't toggle the details element
        navigator.clipboard.writeText(copyText).then(function () {
          copyBtn!.textContent = "✓ Copied!";
          setTimeout(function () { copyBtn!.textContent = "📋 Copy All"; }, 2000);
        }, function () {
          copyBtn!.textContent = "✗ Failed";
          setTimeout(function () { copyBtn!.textContent = "📋 Copy All"; }, 2000);
        });
      });
    }

    state.chatContainer.appendChild(el);
    scrollToBottom();
  }
