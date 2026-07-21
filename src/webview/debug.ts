// ── Debug infrastructure ────────────────────────────────────

import { state } from "./state.js";

// ── Debug state ───────────────────────────────────────────────
const debugEventLog: Array<{ ts: number; type: string; dataKeys: string[]; callId: string; id: string; fromMessage: boolean; toolName: string; stackDepth: number }> = [];
const debugMaxEvents = 500;
const debugDomLog: Array<{ ts: number; action: string; tag: string; id: string; classes: string; status: string; text: string; parentId: string }> = [];
const debugMaxDomLog = 200;
// OFF by default. This was shipped enabled: every non-delta message ran logEvent, which
// constructs an Error to sample the stack, and a MutationObserver watched the whole chat
// container slicing textContent for every added/removed node — a permanent tax on every user.
// The /debug command turns it on (handleDebugCommand), so the diagnostic workflow still works:
// run /debug, reproduce, run /debug again for the captured trace.
let debugEnabled = false;

// ── Queue event tracking ─────────────────────────────────────
const _queueEvents: Array<{ ts: number; steering: number; followUp: number; streaming: boolean }> = [];

// ── MutationObserver ──────────────────────────────────────────
let debugObserver: MutationObserver | null = null;

export function logEvent(type: string, data: Record<string, unknown> | undefined): void {
  if (!debugEnabled) {return;}
  const entry = {
    ts: Date.now(),
    type,
    dataKeys: data ? Object.keys(data).slice(0, 10) : [],
    callId: data ? (data.toolCallId || data.entryId || "") as string : "",
    id: data ? (data.entryId || data.toolCallId || "") as string : "",
    fromMessage: data ? !!data.fromMessage : false,
    toolName: data ? (data.toolName || "") as string : "",
    stackDepth: ((): number => { const s = new Error().stack; return s ? s.split("\n").length : 0; })(),
  };
  debugEventLog.push(entry);
  if (debugEventLog.length > debugMaxEvents) {debugEventLog.shift();}
}

export function logDom(action: string, el: Node | null): void {
  if (!debugEnabled || !el || !(el as HTMLElement).tagName) {return;}
  const htmlEl = el as HTMLElement;
  const entry = {
    ts: Date.now(),
    action,
    tag: htmlEl.tagName.toLowerCase(),
    id: htmlEl.id || "",
    classes: htmlEl.className || "",
    status: htmlEl.getAttribute ? htmlEl.getAttribute("data-status") || "" : "",
    text: (htmlEl.textContent || "").slice(0, 80),
    parentId: htmlEl.parentElement
      ? htmlEl.parentElement.id || htmlEl.parentElement.className || ""
      : "",
  };
  debugDomLog.push(entry);
  if (debugDomLog.length > debugMaxDomLog) {debugDomLog.shift();}
}

/** Snapshot all children of chatContainer for debugging. */
export function dumpChatStructure(): Record<string, unknown> {
  const children: unknown[] = [];
  const { chatContainer, bashBlocks, currentToolBlocks, bashOutputs } = state;

  if (!chatContainer) {return { totalChildren: 0, children: [] };}

  for (let i = 0; i < chatContainer.children.length; i++) {
    const c = chatContainer.children[i] as HTMLElement;
    let bashDetail: Record<string, unknown> | null = null;
    if (c.className && c.className.indexOf("bash-execution") !== -1) {
      const header = c.querySelector(".bash-header");
      const output = c.querySelector(".bash-output");
      const footer = c.querySelector(".bash-footer");
      bashDetail = {
        headerText: header ? header.textContent?.slice(0, 120) : "MISSING",
        outputLen: output ? output.innerHTML.length : -1,
        outputText: output ? output.textContent?.slice(0, 200) : "MISSING",
        footerText: footer ? footer.textContent : "MISSING",
        offsetHeight: c.offsetHeight,
        computedDisplay:
          c.style.display ||
          (typeof getComputedStyle !== "undefined"
            ? getComputedStyle(c).display
            : "?"),
        computedVisibility:
          typeof getComputedStyle !== "undefined"
            ? getComputedStyle(c).visibility
            : "?",
      };
    }
    children.push({
      idx: i,
      tag: c.tagName.toLowerCase(),
      id: c.id || "",
      classes: c.className || "",
      status: c.getAttribute ? c.getAttribute("data-status") : "",
      childCount: c.children.length,
      bashDetail,
    });
  }
  return {
    totalChildren: chatContainer.children.length,
    children,
    bashBlocksKeys: Object.keys(bashBlocks),
    currentToolBlocksKeys: Object.keys(currentToolBlocks),
    trackers: {
      bashBlocksCount: Object.keys(bashBlocks).length,
      currentToolBlocksCount: Object.keys(currentToolBlocks).length,
      bashOutputsCount: Object.keys(bashOutputs).length,
    },
  };
}

export function summary(): Record<string, unknown> {
  const s = dumpChatStructure();
  const el = debugEventLog.slice(-30);
  const dl = debugDomLog.slice(-30);

  const bKeys = new Set(Object.keys(state.bashBlocks));
  const tKeys = new Set(Object.keys(state.currentToolBlocks));
  const dupes: string[] = [];
  bKeys.forEach((k): void => { if (tKeys.has(k)) { dupes.push(k); } });

  const realOrphans: string[] = [];
  const container = state.chatContainer;
  if (container) {
    for (let i = 0; i < container.children.length; i++) {
      const child = container.children[i] as HTMLElement;
      const idMatch = child.id.match(/(?:tool|bash)-(call_\w+)/);
      if (idMatch) {
        const callId = idMatch[1];
        if (!bKeys.has(callId) && !tKeys.has(callId)) {
          realOrphans.push(callId);
        }
      }
      const entryMatch = child.id.match(/entry-(call_\w+)/);
      if (entryMatch) {
        const callId = entryMatch[1];
        if (!bKeys.has(callId) && !tKeys.has(callId)) {
          realOrphans.push(callId);
        }
      }
    }
  }

  const orphanBash: string[] = [];
  bKeys.forEach((k): void => { if (!tKeys.has(k)) { orphanBash.push(k); } });

  return {
    chat: s,
    dupes,
    orphanBash,
    orphanTool: realOrphans,
    lastEvents: el,
    lastDomChanges: dl,
  };
}

// ── Public debug API ────────────────────────────────────────

window.__piDebug = {
  enabled(on: boolean): boolean {
    debugEnabled = on;
    return debugEnabled;
  },
  dumpState: dumpChatStructure,
  eventLog(n?: number): unknown[] {
    return debugEventLog.slice(-(n || 50));
  },
  domLog(n?: number): unknown[] {
    return debugDomLog.slice(-(n || 50));
  },
  bashBlocks(): unknown[] {
    return Object.keys(state.bashBlocks).map((k) => {
      const el = state.bashBlocks[k];
      return {
        id: k,
        status: el && typeof el.getAttribute === "function"
          ? el.getAttribute("data-status")
          : "?",
        tag: el?.tagName,
      };
    });
  },
  toolBlocks(): unknown[] {
    return Object.keys(state.currentToolBlocks).map((k) => {
      const e = state.currentToolBlocks[k];
      if (!e) { return { id: k, status: "MISSING", tag: "?", hasRenderer: false }; }
      const el = "tagName" in e ? e : e.el;
      return {
        id: k,
        status: el.getAttribute ? el.getAttribute("data-status") : "?",
        tag: el.tagName,
        hasRenderer: !("tagName" in e) && !!e.renderer,
      };
    });
  },
  summary,
  _queueEvents,
};

// ── MutationObserver setup ───────────────────────────────────

export function initDebugObserver(): void {
  if (typeof MutationObserver === "undefined") {return;}
  debugObserver = new MutationObserver((mutations: MutationRecord[]): void => {
    if (!debugEnabled) {return;}
    mutations.forEach((m): void => {
      for (let i = 0; i < m.addedNodes.length; i++) {
        logDom("added", m.addedNodes[i]);
      }
      for (let j = 0; j < m.removedNodes.length; j++) {
        logDom("removed", m.removedNodes[j]);
      }
    });
  });
  if (state.chatContainer) {
    debugObserver.observe(state.chatContainer, { childList: true });
  }
}

export { debugEventLog, debugEnabled };
