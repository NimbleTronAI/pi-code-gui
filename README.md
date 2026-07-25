# Pi on Code

A keyboard-first Pi coding agent workspace inside VS Code.

Pi on Code preserves the compact information hierarchy of Pi's terminal UI:
the conversation is the primary surface, tool runs appear as terse command
rows, and model, thinking, context, and queue state stay visible in a quiet
status line.

## Features

- Run real Pi agent sessions from a VS Code editor tab.
- Stream assistant text, thinking, tool calls, shell output, and file changes.
- Use multiple sessions with independent model and thinking settings.
- Resume Pi's standard JSONL sessions.
- Reference files, run slash commands, steer an active turn, or queue a
  follow-up.
- Give Pi access to editor diagnostics, symbols, definitions, references,
  workspace edits, and other VS Code-native tools.
- Install and manage Pi packages from the Activity Bar.

## Requirements

- VS Code 1.118 or newer.
- Node.js 22 or newer.
- The Pi coding agent:

```powershell
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Authenticate Pi from a terminal first, or run `Pi: Set Up API Key / Login` from
the Command Palette.

## Use

1. Install `pi-on-code-0.1.0.vsix`.
2. Open a folder in VS Code.
3. Run `Pi: Code Agent` or press `Ctrl+Alt+I`.
4. Type a request and press Enter.

Useful shortcuts:

- `Enter`: steer or send
- `Alt+Enter`: queue a follow-up
- `Ctrl+L`: choose model
- `Ctrl+P`: cycle favorite models
- `Ctrl+/`: command picker

## Development

```powershell
pnpm install
pnpm run compile
pnpm run vsix
```

Press F5 in VS Code to launch the Extension Development Host.

## Architecture and attribution

The SDK lifecycle, session persistence, VS Code bridge tools, event
translation, webview protocol, and packaging pipeline are adapted from
Pi Code Gui. Pi on Code introduces its own product identity and the Pi Web
terminal-style visual system.

The inherited implementation is licensed under the MIT License. See
详见项目根目录的 `LICENSE` 文件。
