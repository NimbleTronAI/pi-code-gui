// Manages a single out-of-process Rust Pi agent running in RPC mode
// (`pi --mode rpc`). Speaks the line-delimited JSON protocol over stdin/stdout
// (LF framing), correlates request/response by `id`, and forwards all other
// lines as raw events. It does NOT translate events into PiServiceEvents —
// PiService routes the raw events through its existing handleAgentEvent path,
// since the Rust event shapes mirror the TypeScript SDK's.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { piDebug, piWarn } from "./logger.js";

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
  private seq = 0;
  private pending = new Map<string, { resolve: (r: RustResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private disposed = false;
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
      this.failAllPending(new Error(`Rust process exited (code ${code ?? "?"})`));
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
          settleReject(new Error(`Rust process exited immediately (code ${code}): ${this.stderrBuf.trim().slice(0, 400)}`));
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
      if (line.trim()) { piWarn(`[rust-stderr] ${line}`); }
    }
    if (this.stderrBuf.length > 8192) { this.stderrBuf = this.stderrBuf.slice(-4096); }
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
