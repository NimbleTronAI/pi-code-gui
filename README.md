# Pi on Code

Pi on Code is a Pi-native coding-agent extension for VS Code. It brings Pi's
sessions, package ecosystem, extension runtime, and agent workflow into a
first-class editor workspace instead of wrapping them in a generic chat UI.

It combines persistent multi-session conversations, rich streaming tool
output, Package and Extension management, and direct access to VS Code code
intelligence. The interface follows Pi's compact terminal-inspired visual
language while supporting both dark and light editor themes.

## Screenshots

### Dark theme

![Pi on Code dark workspace with sessions, Packages, extension prompts, and streaming tool output](media/pi-on-code-dark-readme.png)

### Light theme

![Pi on Code light workspace with sessions, Packages, extension prompts, and streaming tool output](media/pi-on-code-light-readme.png)

## Features

- Run real Pi agent sessions in VS Code while keeping compatibility with Pi's
  standard settings, Packages, and JSONL session files.
- Work across multiple persistent sessions with independent models and
  thinking levels; resume, switch, or delete sessions from the Activity Bar.
- Stream assistant text, thinking, tool calls, shell output, file previews,
  and diffs in a compact conversation view.
- Steer an active turn or queue, edit, reorder, and promote follow-up messages.
- Install and update Pi Packages, preview marketplace media, and enable or
  disable Session extensions without leaving the sidebar.
- Render extension questions and UI interactions directly inside the
  conversation.
- Give Pi access to editor diagnostics, symbols, definitions, references,
  workspace edits, open tabs, and other VS Code-native context.
- Track model, thinking, effort, context usage, active extensions, and agent
  activity without adding a separate conversation header.

## Install

Install **Pi on Code** from the Visual Studio Marketplace, or run:

```powershell
code --install-extension auchan.pi-on-vsc
```

The extension activates when you open its Activity Bar view or run a contributed
Pi command; it does not open a chat tab automatically by default.

## Requirements

- VS Code 1.118 or newer.
- Node.js 22 or newer.
- Pi coding agent 0.80.8 through 0.82.1 (current verified compatibility
  range).

Pi 0.80.8 is the minimum supported release because Pi on Code uses the
`ModelRuntime`-based SDK introduced in [Pi 0.80.8](https://pi.dev/news/releases/0.80.8).
The required Session, Extension Runner, Package Manager, and Settings APIs have
been verified through Pi 0.82.1. See the [Pi release notes](https://pi.dev/news)
for upstream changes.

Install the latest compatible Pi release globally:

```powershell
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.82.1
```

Authenticate Pi from a terminal first, run `Pi: Set Up API Key / Login`, or use
`Pi: Set Anthropic API Key` / `Pi: Set OpenAI API Key` from the Command Palette.
API keys entered through these commands are stored in VS Code SecretStorage.

## Use

1. Open a trusted folder in VS Code.
2. Open the Pi on Code Activity Bar view or run `Pi: Code Agent` (`Ctrl+Alt+I`).
3. Type a request and press Enter.

Shortcuts inside the Pi chat input:

- `Enter`: steer or send
- `Alt+Enter`: queue a follow-up
- `Ctrl+L`: choose model
- `Ctrl+P`: cycle favorite models
- `Ctrl+/`: command picker

Only `Ctrl+Alt+I` is registered as a global VS Code shortcut, so Pi on Code does
not replace standard editor bindings such as Quick Open or Toggle Line Comment.

## Security and privacy

Pi on Code is an agent extension: when you approve or request work, Pi can read
and modify workspace files and execute shell commands. For this reason the
extension is disabled in Restricted Mode and requires a trusted, non-virtual
workspace. Review project context files such as `AGENTS.md` before use because
Pi loads them as instructions.

Prompts, attached editor content, and tool results are sent by Pi to the model
provider you configure. Their handling is governed by that provider's terms and
privacy policy. Pi on Code does not add telemetry or send usage analytics of its
own. Provider API keys entered through Pi on Code are stored with VS Code
SecretStorage rather than in `settings.json`; use `Pi: Clear Stored API Keys` to
remove them.

Report security or functional issues through the
[GitHub issue tracker](https://github.com/auchan/pi-on-code/issues). Do not include
API keys, session transcripts, or proprietary source code in reports.

## Development

```powershell
bun install
bun run compile
bun run build
bun run install:vsix
```

`bun run build` checks types and lint, creates production bundles, and writes
`artifacts/pi-on-vsc-<version>.vsix`. `bun run install:vsix` force-installs
that generated package into VS Code. Press F5 in VS Code to launch the
Extension Development Host.

## Architecture

[![Pi on Code architecture](media/architecture.png)](media/architecture.svg)

## Attribution

The SDK lifecycle, session persistence, VS Code bridge tools, event
translation, webview protocol, and packaging pipeline are adapted from
[Pi Code Gui](https://github.com/NimbleTronAI/pi-code-gui). Pi on Code
introduces its own product identity, multi-session workspace, integrated
Package and Extension experience, and a Pi-inspired visual system for light
and dark themes.

The inherited implementation is licensed under the MIT License. Original
copyright notices are retained, and Pi on Code contributions are distributed
under the same license. See the `LICENSE` file in the project root.
