// ── Global type declarations for the webview ─────────────────

// VS Code API (provided by the webview host)
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

// Override querySelector to return HTMLElement instead of Element.
// In the webview, all querySelector results are HTML elements.
interface ParentNode {
  querySelector<E extends HTMLElement = HTMLElement>(selectors: string): E | null;
  querySelectorAll<E extends HTMLElement = HTMLElement>(selectors: string): NodeListOf<E>;
}

interface Element {
  querySelector<E extends HTMLElement = HTMLElement>(selectors: string): E | null;
  querySelectorAll<E extends HTMLElement = HTMLElement>(selectors: string): NodeListOf<E>;
}

// External libraries loaded as globals
declare let marked: {
  parse(text: string): string;
  lexer(text: string): Array<{ type: string; raw: string; [key: string]: unknown }>;
  setOptions(opts: Record<string, unknown>): void;
};
declare let morphdom: (
  from: Node,
  to: Node | string,
  opts?: { childrenOnly?: boolean },
) => void;

// Custom properties on Window
interface Window {
  __piDebug: {
    enabled(on: boolean): boolean;
    dumpState(): unknown;
    eventLog(n?: number): unknown[];
    domLog(n?: number): unknown[];
    bashBlocks(): unknown[];
    toolBlocks(): unknown[];
    summary(): Record<string, unknown>;
    _queueEvents?: unknown[];
  };
  __piRegisterToolRenderer?: (name: string, renderer: unknown) => void;
  __piRegisterMessageRenderer?: (
    type: string,
    renderer: (data: unknown, ...args: unknown[]) => void,
  ) => void;
  __vscode: ReturnType<typeof acquireVsCodeApi>;
  morphdom: typeof morphdom;
}

// Event data shape (from extension host to webview)
interface WebviewEventData {
  [key: string]: unknown;
  message?: string;
  error?: string;
  content?: string;
  display?: boolean;
  details?: Record<string, unknown>;
  role?: string;
  entryId?: string;
  delta?: string;
  done?: boolean;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  partialResult?: { content?: Array<{ type: string; text: string }> };
  result?: {
    content?: Array<{ type: string; text: string }>;
    details?: {
      truncation?: {
        truncated: boolean;
        truncatedBy?: string;
        totalLines: number;
        outputLines: number;
        outputBytes: number;
        maxBytes?: number;
        maxLines?: number;
        firstLineExceedsLimit?: boolean;
      };
    };
  };
  isError?: boolean;
  command?: string;
  reason?: string;
  aborted?: boolean;
  willRetry?: boolean;
  errorMessage?: string;
  success?: boolean;
  finalError?: string;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  steering?: string[];
  followUp?: string[];
  level?: string;
  messages?: Array<{ text: string }>;
  commands?: Array<{ cmd: string; desc: string }>;
  customType?: string;
  timestamp?: number;
  key?: string;
  dialogType?: string;
  id?: string;
  prompt?: string;
  options?: string[];
  defaultValue?: string;
  hasEntries?: boolean;
  sourceCode?: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
  stopReason?: string;
  toolCalls?: string[];
  summary?: string;
  tokensBefore?: number;
}

// Allow dynamic properties on HTMLElement for component state
interface HTMLElement {
  _component?: unknown;
  _rawText?: string;
  // Corrected to match what the renderers actually store. These were only ever reached through
  // `(el as any)._x`, so the declarations drifted from reality unchecked: the code assigns null
  // to the rAF/pending slots (declared non-nullable), stores an unknown-typed rawPath (declared
  // string), and calls .update()/.getResultEl() on _toolBlock (declared unknown).
  // Inline import() keeps this file a GLOBAL augmentation (a top-level import would turn it
  // into a module and silently drop every declaration here), so consistent-type-imports has to
  // be waived on exactly this line — there is no top-level-import form that preserves the file.
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  _toolBlock?: import("./components/tool-block.js").ToolBlock;
  _writeState?: { content: string; lang?: string; rawPath?: unknown };
  _writePending?: string | null;
  _writeRafId?: number | null;
  _editEdits?: Array<{ oldText: string; newText: string }>;
  _editLang?: string;
  _readState?: { rawPath?: unknown; lang?: string; compact?: unknown; offset?: unknown };
  _readCollapseState?: {
    previewText: string;
    fullText: string;
    lang?: string;
    remaining: number;
    totalLines: number;
    expanded: boolean;
  };
  _spinnerInterval?: ReturnType<typeof setInterval>;
  _countdownInterval?: ReturnType<typeof setInterval>;
  _pendingUpdate?: string;
  _pendingBashRender?: string;
  _cachedContent?: string;
  _baselineText?: string;
}
