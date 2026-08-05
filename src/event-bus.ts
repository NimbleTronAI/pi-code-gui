// The PiService → webview event bus. A tiny subscribe/emit hub with two cross-cutting
// concerns worth isolating and testing: (1) every outgoing event is validated against the
// runtime protocol schema, and on failure we STILL emit (backward-compat) but log it and push
// a visible diagnostic; (2) a throwing listener is caught so one bad subscriber can't break the
// dispatch to the others. vscode-free — validation + logging are injected.
import type { PiServiceEvent } from "./types.js";

export type Listener = (event: PiServiceEvent) => void;
export type ValidateFn = (event: PiServiceEvent) => { success: boolean; error?: string };

const typeOf = (event: PiServiceEvent): string => String((event as Record<string, unknown>).type);

export class EventBus {
  private listeners: Listener[] = [];

  /** @param validate protocol schema check (validateExtensionToWebview)
   *  @param warn diagnostic sink (piWarn) */
  constructor(private readonly validate: ValidateFn, private readonly warn: (message: string) => void) {}

  /** Number of attached listeners — callers use 0 to mean "no webview attached" (e.g. dialogs
   *  fall back to text prompts). */
  get listenerCount(): number { return this.listeners.length; }

  /** Subscribe; returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
  }

  /** Validate then dispatch. On validation failure: log, push a diagnostic custom-message, and
   *  STILL emit the original event (backward compat). Listener exceptions are isolated. */
  emit(event: PiServiceEvent): void {
    const result = this.validate(event);
    if (!result.success) {
      this.warn(`[protocol] emit validation failed for type "${typeOf(event)}": ${result.error}`);
      this.emitSafe({
        type: "custom-message",
        data: {
          customType: "pi-gui-diagnostic",
          content: `Protocol validation error (type: ${typeOf(event)}): ${String(result.error).substring(0, 200)}`,
          display: false,
        },
      });
    }
    this.dispatch(event, "emit");
  }

  /** Emit without validation — used for the diagnostics emit above (avoids recursive
   *  validation) and any internally-trusted event. */
  emitSafe(event: PiServiceEvent): void {
    this.dispatch(event, "emitSafe");
  }

  private dispatch(event: PiServiceEvent, label: string): void {
    for (const l of this.listeners) {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      try { l(event); } catch (e: any) {
        this.warn(`${label} listener threw for type "${typeOf(event)}": ${e?.message ?? e}`);
      }
    }
  }
}
