// Manages a single out-of-process Rust Pi agent running in RPC mode
// (`pi --mode rpc`). Speaks the line-delimited JSON protocol over stdin/stdout
// (LF framing), correlates request/response by `id`, and forwards all other
// lines as raw events. It does NOT translate events into PiServiceEvents —
// PiService routes the raw events through its existing handleAgentEvent path,
// since the Rust event shapes mirror the TypeScript SDK's.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { piDebug, piWarn } from "./logger.js";
import { classifyRustLoadError, formatRustLoadError, type RustLoadError } from "./extension-errors.js";

export interface RustResponse {
  type: "response";
  id?: string;
  command?: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface RustEvent { type: string;[k: string]: any; }

/** How long to wait after "exit" for stdio to close before giving up on the stderr that
 *  explains the exit. Generous enough for a normal flush, short enough that a genuinely stuck
 *  pipe doesn't stall the error the user is waiting on. */
const DRAIN_GRACE_MS = 250;

/** RPC command names PiService sends to the Rust subprocess. Centralized so a
 *  typo is a compile error rather than a silent timeout, and so call sites are
 *  greppable/refactorable. Values verified against rust-pi 0.1.18. */
export const RUST_RPC = {
  getState: "get_state",
  getAvailableModels: "get_available_models",
  getMessages: "get_messages",
  getCommands: "get_commands",
  getSessionStats: "get_session_stats",
  prompt: "prompt",
  steer: "steer",
  followUp: "follow_up",
  abort: "abort",
  abortBash: "abort_bash",
  compact: "compact",
  setModel: "set_model",
  setThinkingLevel: "set_thinking_level",
  setAutoCompaction: "set_auto_compaction",
  setAutoRetry: "set_auto_retry",
  extensionUiResponse: "extension_ui_response",
  askResponse: "ask_response",
} as const;

export interface RustProcessOpts {
  binaryPath: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Every non-`response` line (agent events, extension_ui_request, etc.). */
  onEvent: (e: RustEvent) => void;
  /** Called once when the process exits unexpectedly (not via dispose()). */
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** Called the first time a given extension-load failure (digest mismatch,
   *  unsupported module, …) appears on stderr — deduped per (kind, package) so
   *  the host can surface it once, elegantly, instead of per repeated line. */
  onLoadError?: (e: RustLoadError) => void;
  /** If set, `spawn()` resolves only when this RPC command first responds — a
   *  real readiness signal (the binary emits no startup event), replacing the
   *  old fixed timer. Omit to fall back to a short "did it crash immediately?"
   *  window. */
  readyCommand?: string;
  /** Timeout for the readiness probe (default 15000ms). */
  readyTimeoutMs?: number;
}

export class RustProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuf = "";
  private stderrBuf = "";
  /** Rolling tail of stderr for crash diagnostics. onStderr DRAINS stderrBuf line-by-line, so
   *  that buffer only ever holds a trailing partial line and can't serve as history — a pending
   *  request rejected by a mid-session crash would otherwise carry no clue why. Capped so a
   *  chatty binary can't grow it unbounded. */
  private stderrTail = "";
  private seq = 0;
  private pending = new Map<string, { resolve: (r: RustResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private disposed = false;
  /** (kind:package) keys already reported, so a repeated load failure on stderr
   *  is logged once at warn level and thereafter only at debug. */
  private readonly seenLoadErrors = new Set<string>();
  private readonly opts: RustProcessOpts;

  constructor(opts: RustProcessOpts) { this.opts = opts; }

  /** Spawn the process and resolve once it's ready (readiness probe) or running
   *  (timer fallback); reject on immediate failure. */
  async spawn(): Promise<void> {
    const { binaryPath, args, cwd, env } = this.opts;
    piDebug(`RustProcess: spawn ${binaryPath} ${args.join(" ")}`);
    const child = spawn(binaryPath, args, {
      cwd,
      env: env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: string) => this.onStderr(chunk));

    child.on("error", (err: Error) => {
      piWarn(`RustProcess: error: ${err.message}`);
      this.failAllPending(err);
    });
    child.on("exit", (code, signal) => {
      piDebug(`RustProcess: exited code=${code} signal=${signal}`);
      // Drain first — see afterStderrDrained. Reading stderrTail on "exit" loses the very
      // message that explains the exit.
      this.afterStderrDrained(child, () => {
        this.failAllPending(new Error(`Rust process exited (code ${code ?? "?"})${this.stderrHint()}`));
      });
      if (!this.disposed) { this.opts.onExit(code, signal); }
    });

    // Resolve on a real readiness signal when `readyCommand` is set: the binary
    // emits no startup event, so we confirm it by a round-trip RPC (resolves as
    // soon as it answers — fast for healthy starts, and a hung binary surfaces
    // here rather than hanging the first real request). Without `readyCommand`,
    // fall back to a short window that just catches an immediate spawn failure
    // (ENOENT, glibc mismatch, …). Either way, an immediate error/exit rejects.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settleResolve = (): void => { if (!settled) { settled = true; resolve(); } };
      const settleReject = (e: Error): void => { if (!settled) { settled = true; reject(e); } };
      child.once("error", settleReject);
      child.once("exit", (code) => {
        if (code !== 0 && code !== null) {
          this.afterStderrDrained(child, () => {
            settleReject(new Error(`Rust process exited immediately (code ${code})${this.stderrHint()}`));
          });
        }
      });
      if (this.opts.readyCommand) {
        this.request(this.opts.readyCommand, {}, this.opts.readyTimeoutMs ?? 15000)
          .then(settleResolve, (e: unknown) => settleReject(e instanceof Error ? e : new Error(String(e))));
      } else {
        setTimeout(settleResolve, 400);
      }
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    // Strict LF framing per the RPC contract; tolerate a trailing CR.
    while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).replace(/\r$/, "");
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (line.trim()) { this.dispatchLine(line); }
    }
  }

  private onStderr(chunk: string): void {
    this.stderrBuf += chunk;
    let idx: number;
    while ((idx = this.stderrBuf.indexOf("\n")) >= 0) {
      const line = this.stderrBuf.slice(0, idx);
      this.stderrBuf = this.stderrBuf.slice(idx + 1);
      this.handleStderrLine(line);
    }
    if (this.stderrBuf.length > 8192) { this.stderrBuf = this.stderrBuf.slice(-4096); }
  }

  /** Route one stderr line. Recognized extension-load failures (and pi's own
   *  multi-line "Remediation:" hint) are caught: the first of each unique
   *  failure is reported once via onLoadError + a clean warning, repeats and the
   *  raw remediation hint go to debug. Everything else is genuine stderr. */
  private handleStderrLine(line: string): void {
    if (!line.trim()) { return; }
    this.stderrTail += line + "\n";
    if (this.stderrTail.length > 4000) { this.stderrTail = this.stderrTail.slice(-2000); }
    const diag = classifyRustLoadError(line);
    if (diag) {
      const key = `${diag.kind}:${diag.packageName ?? ""}`;
      if (this.seenLoadErrors.has(key)) { piDebug(`[rust-stderr] ${line}`); return; }
      this.seenLoadErrors.add(key);
      piWarn(formatRustLoadError(diag));
      this.opts.onLoadError?.(diag);
      return;
    }
    // pi prints its own "Remediation: …" hint after a load failure; we emit our
    // own remediation, so keep the raw hint out of the warning stream.
    if (/^\s*Remediation:/i.test(line)) { piDebug(`[rust-stderr] ${line}`); return; }
    piWarn(`[rust-stderr] ${line}`);
  }

  private dispatchLine(line: string): void {
    let obj: RustEvent | RustResponse;
    try {
      obj = JSON.parse(line);
    } catch {
      piWarn(`RustProcess: non-JSON stdout line: ${line.slice(0, 200)}`);
      return;
    }
    if (obj && obj.type === "response") {
      const resp = obj as RustResponse;
      const id = resp.id;
      if (id && this.pending.has(id)) {
        const p = this.pending.get(id)!;
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.resolve(resp);
      }
      return;
    }
    try {
      this.opts.onEvent(obj);
    } catch (e: unknown) {
      piWarn(`RustProcess: onEvent threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private writeLine(obj: unknown): void {
    if (!this.child || !this.child.stdin.writable) {
      piWarn("RustProcess: stdin not writable; dropping command");
      return;
    }
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  /** Fire-and-forget command (prompt/steer/abort/…). Effects arrive as events. */
  send(command: string, payload?: Record<string, unknown>): void {
    this.writeLine({ type: command, ...(payload ?? {}) });
  }

  /** Command that returns data, correlated by a generated `id`. */
  request(command: string, payload?: Record<string, unknown>, timeoutMs = 30000): Promise<RustResponse> {
    const id = `rpc-${++this.seq}`;
    return new Promise<RustResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC '${command}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writeLine({ type: command, id, ...(payload ?? {}) });
    });
  }

  /** True while the subprocess is spawned and has neither exited nor been
   *  disposed — used to detect a crash during the init handshake. */
  isAlive(): boolean {
    return !!this.child && !this.disposed && this.child.exitCode === null;
  }

  /** Trailing stderr, formatted for attaching to a rejection ("" when the binary said nothing). */
  private stderrHint(): string {
    const t = this.stderrTail.trim();
    return t ? ` — last stderr: ${t.slice(-500)}` : "";
  }

  /** Run `done` once the child's stdio has actually drained.
   *
   *  Node fires "exit" when the process terminates, but its stdio streams may still have
   *  buffered data; "close" is the event that fires after they are all closed. Building the
   *  failure message on "exit" therefore RACES the stderr that explains the failure, and loses
   *  it whenever the binary does async work before printing. Observed exactly that: an
   *  argv-parse rejection (written and exited almost synchronously) carried its stderr through,
   *  while an expired-OAuth exit — the binary attempts a token refresh first — reached the user
   *  as a bare "exited immediately (code 1)" with the actionable text stripped off, even though
   *  the binary had printed "OAuth token expired or invalid / Run 'pi login <provider>'".
   *
   *  Idempotent by contract: both callers guard against a double call, so the timeout backstop
   *  is safe if "close" never arrives (a detached grandchild holding the pipe open). */
  private afterStderrDrained(child: { once(ev: string, cb: () => void): unknown }, done: () => void): void {
    let ran = false;
    const run = (): void => { if (!ran) { ran = true; done(); } };
    child.once("close", run);
    setTimeout(run, DRAIN_GRACE_MS);
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  /** Terminate the subprocess (SIGTERM → SIGKILL) and reject any pending requests. */
  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.failAllPending(new Error("Rust process disposed"));
    const child = this.child;
    this.child = null;
    if (!child) { return; }
    try { child.stdin.end(); } catch { /* ignore */ }
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    setTimeout(() => {
      // Escalate to SIGKILL if the process hasn't exited. Gate on exitCode, NOT
      // child.killed — `killed` flips true the moment a signal is *delivered*
      // (i.e. right after the SIGTERM above), so `!child.killed` would always be
      // false and the SIGKILL would never fire, leaking unresponsive children.
      try { if (child.exitCode === null) { child.kill("SIGKILL"); } } catch { /* ignore */ }
    }, 2000).unref?.();
  }
}
