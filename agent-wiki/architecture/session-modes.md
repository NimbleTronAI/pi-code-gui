# Session Modes — plan mode and approval

> **Status:** evolving

rust-pi 0.3.0 can draft a plan before touching anything, and can be told how much to
run without asking. It reports **neither** over RPC, so the extension owns both. The
mode strip (`#pi-mode-strip`, above the prompt input) is where they live: it states
what the *next* message will do, and changes it before submitting.

## Plan mode

Verified wire contract — undocumented upstream, established by probing the binary:

| Step | Command | Result |
| --- | --- | --- |
| enter / leave | `set_plan_mode {mode: "on"\|"off"}` | `{planMode: "planning"\|"off"}` |
| model submits | `submit_plan` tool | result details `{planReview: "pending"}` |
| accept | `approve_plan` | `{approved: true, plan: "…"}` |
| reject | `reject_plan` | `{rejected: true}` |

Three properties shape the UI. `get_state` never reports the mode and no event marks a
transition, so `RustService._planMode` is the only place it is known — per-session,
reset by a restart. `approve_plan` does **not** resume the agent, so approving
pre-fills the composer rather than leaving an idle session. And `reject_plan` carries
no feedback field, so a reason must travel as an ordinary follow-up prompt.

While planning, the binary refuses write-shaped tools with `[PLAN_MODE_BLOCKED]`.

## Approval mode

`always-ask` (default), `write`, `yolo`. The CLI flags are **inert over RPC** —
`--approval-mode` and `--yolo` all leave a session in `always-ask`, which made the
Rust runtime unable to edit anything at all. The working lever is `approval.mode` in
the shared agent home's `settings.json`; `{"approval": "yolo"}` hangs startup and
`{"approvalMode": …}` is ignored.

Two consequences the UI states rather than hides. rust-pi reads approval **only at
startup**, so the chip reports the posture the running session was *spawned* with
(`RustService._approvalAtStart`) — never the file's current value, which the session
would not be obeying. Changing it therefore restarts the session, resuming the same
JSONL so the transcript carries forward. And because the home is shared, the setting
applies to the `pi` CLI too.

## Defaults

`pi-code-gui.defaultMode` and `pi-code-gui.defaultApproval` seed new sessions, offered
through the same two-row "save as default?" step the model picker uses.
`pi-code-gui.confirmApprovalRestart` suppresses the restart prompt.

## Cross-reference

- [Model Catalog & the Shared Agent Home](model-catalog.md) — where `settings.json` lives
- [PiBackend](pi-backend.md) — the capability seam these flow through
- [Extension UI Bridge](extension-ui-bridge.md) — the `ask` card, the other blocking RPC

> **Last updated:** 2026-08-31 — new page for 0.2.0.
