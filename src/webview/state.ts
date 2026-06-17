// ── Shared application state ────────────────────────────────
//
// Single source of truth for all mutable state in the webview.
// Exported as a mutable object so any module can read or write
// fields freely (same as the old window.__pi.state namespace).
//
// DOM refs are populated by initState(document) on startup.

export interface AppState {
  // ── Boolean flags
  isStreaming: boolean;
  isCompacting: boolean;
  isRetrying: boolean;
  _inBatch: boolean;

  // ── DOM element references (current streaming state)
  currentAssistantEl: HTMLElement | null;
  currentThinkingEl: HTMLElement | null;

  // ── Tool execution tracking
  currentToolBlocks: Record<string, { el: HTMLElement; renderer?: unknown } | HTMLElement | undefined>;
  assistantToolCallIds: Record<string, boolean>;
  /** Last tool/batch block inserted after the current assistant message.
   *  Subsequent tools insert after this one to preserve call order. */
  lastToolInsertionEl: HTMLElement | null;

  // ── Message tracking
  lastUserMessageContent: string | null;
  userMessagesSeen: number;
  userMessageHistory: Array<{ text: string }>;

  // ── Attachments
  attachments: Array<{
    id: string;
    type: string;
    name: string;
    mediaType: string;
    data: string | null;
    blobUrl: string | null;
  }>;

  // ── Bash execution blocks
  bashBlocks: Record<string, HTMLElement>;
  bashOutputs: Record<string, string>;

  // ── Truncation text store
  truncationTexts: Record<string, { preview: string; full: string }>;
  truncationIdx: number;

  // ── Settings
  settingsState: { autoCompaction: boolean; autoRetry: boolean; showImages: boolean };
  settingsOpen: boolean;

  // ── Scoped models
  scopedModels: unknown[];

  // ── Overlay state
  userMsgSelectorOpen: boolean;
  userMsgSelectedIdx: number;
  slashAutocompleteOpen: boolean;
  slashFilter: string;
  slashSelectedIdx: number;

  // ── Tool renderer registry
  toolRenderers: Record<string, {
    create: (data: Record<string, unknown>) => HTMLElement;
    update: (el: HTMLElement, partialResult: Record<string, unknown>) => void;
    finalize: (el: HTMLElement, result: Record<string, unknown>, isError: boolean, entryId?: string) => void;
  }>;

  // ── Stream rendering (RAF-batched)
  _streamRafId: number | null;
  _streamContentEl: HTMLElement | null;
  _streamPrevTokens: unknown[];
  _thinkingRafId: number | null;
  _thinkingEl: HTMLElement | null;

  // ── Scroll tracking
  hasScrolledUp: boolean;

  // ── Queue/steer mode
  queueMode: "steer" | "queue";

  // ── Marked availability flag
  _markedAvailable: boolean;

  // ── Custom message renderer registry
  messageRenderers: Record<string, (data: unknown, container: HTMLElement, ...rest: unknown[]) => void>;

  // ── Live panel cards
  liveCards: Record<string, HTMLElement & { _component?: unknown }>;
  widgetCards: Record<string, HTMLElement>;

  // ── Slash commands
  builtinSlashCommands: Array<{ cmd: string; desc: string }>;
  extensionSlashCommands: Array<{ cmd: string; desc: string }>;
  localSlashCommands: string[];

  // ── DOM refs (always populated by initState before any handler runs)
  chatContainer: HTMLElement;
  promptInput: HTMLTextAreaElement;
  sendButton: HTMLButtonElement;
  abortButton: HTMLButtonElement;
  steerDropdown: HTMLButtonElement;
  welcome: HTMLElement | null;
  attachmentBar: HTMLElement;
  userMsgOverlay: HTMLElement;
  settingsOverlay: HTMLElement;
  slashAutocomplete: HTMLElement;
  livePanel: HTMLElement;
  sbDot: HTMLElement;
  sbModel: HTMLElement;
  sbThinking: HTMLElement;
  sbEffort: HTMLElement;
  sbUsage: HTMLElement;
}

export const state: AppState = {
  isStreaming: false,
  isCompacting: false,
  isRetrying: false,
  _inBatch: false,

  currentAssistantEl: null,
  currentThinkingEl: null,

  currentToolBlocks: {},
  assistantToolCallIds: {},
  lastToolInsertionEl: null,

  lastUserMessageContent: null,
  userMessagesSeen: 0,
  userMessageHistory: [],

  attachments: [],

  bashBlocks: {},
  bashOutputs: {},

  truncationTexts: {},
  truncationIdx: 0,

  settingsState: { autoCompaction: true, autoRetry: true, showImages: true },
  settingsOpen: false,

  scopedModels: [],

  userMsgSelectorOpen: false,
  userMsgSelectedIdx: 0,
  slashAutocompleteOpen: false,
  slashFilter: "",
  slashSelectedIdx: 0,

  toolRenderers: {},

  _streamRafId: null,
  _streamContentEl: null,
  _streamPrevTokens: [],
  _thinkingRafId: null,
  _thinkingEl: null,

  hasScrolledUp: false,

  queueMode: "steer",

  _markedAvailable: false,

  messageRenderers: {},

  liveCards: {},
  widgetCards: {},

  builtinSlashCommands: [
    { cmd: "/compact", desc: "Compact context" },
    { cmd: "/resume", desc: "Resume a previous session" },
    { cmd: "/export", desc: "Export session to HTML" },
    { cmd: "/fork", desc: "Fork session from message" },
    { cmd: "/sessions", desc: "List sessions" },
    { cmd: "/model", desc: "Change model" },
    { cmd: "/thinking", desc: "Set thinking level" },
    { cmd: "/new", desc: "Start new session" },
    { cmd: "/settings", desc: "Open settings" },
    { cmd: "/login", desc: "Configure provider authentication" },
    { cmd: "/logout", desc: "Remove provider authentication" },
    { cmd: "/debug", desc: "Dump webview state for troubleshooting" },
  ],
  extensionSlashCommands: [],
  localSlashCommands: [
    "/login", "/logout", "/debug", "/model", "/thinking", "/sessions", "/settings",
    // Session ops the extension services itself — must be intercepted here so they
    // reach handleSlashCommand → the runtime-aware router, instead of being sent to
    // the model as a prompt. (TypeScript's SDK parses such prompts; the Rust RPC
    // does NOT, so /compact, /new etc. otherwise just talk to the model under Rust.)
    "/new", "/clear", "/compact",
  ],

  chatContainer: null!,
  promptInput: null!,
  sendButton: null!,
  abortButton: null!,
  steerDropdown: null!,
  welcome: null,
  attachmentBar: null!,
  userMsgOverlay: null!,
  settingsOverlay: null!,
  slashAutocomplete: null!,
  livePanel: null!,
  sbDot: null!,
  sbModel: null!,
  sbThinking: null!,
  sbEffort: null!,
  sbUsage: null!,
};

/** Populate DOM refs from document. Call once on startup. */
export function initState(doc: Document): void {
  state.chatContainer = doc.getElementById("chat-container")!;
  state.promptInput = doc.getElementById("prompt-input") as HTMLTextAreaElement;
  state.sendButton = doc.getElementById("send-button") as HTMLButtonElement;
  state.abortButton = doc.getElementById("abort-button") as HTMLButtonElement;
  state.steerDropdown = doc.getElementById("steer-dropdown") as HTMLButtonElement;
  state.welcome = doc.getElementById("welcome")!;
  state.attachmentBar = doc.getElementById("attachment-bar")!;
  state.userMsgOverlay = doc.getElementById("user-msg-overlay")!;
  state.settingsOverlay = doc.getElementById("settings-overlay")!;
  state.slashAutocomplete = doc.getElementById("slash-autocomplete")!;
  state.livePanel = doc.getElementById("live-panel")!;
  state.sbDot = doc.getElementById("pi-sb-dot")!;
  state.sbModel = doc.getElementById("pi-sb-model")!;
  state.sbThinking = doc.getElementById("pi-sb-thinking")!;
  state.sbEffort = doc.getElementById("pi-sb-effort")!;
  state.sbUsage = doc.getElementById("pi-sb-usage")!;

  if (typeof marked !== "undefined") {
    state._markedAvailable = true;
  }
}

if (typeof document !== "undefined") {
  initState(document);
}
