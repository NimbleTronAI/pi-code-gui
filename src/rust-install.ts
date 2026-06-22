// On-demand installation of the Rust Pi binary. Offers the user a choice of
// methods (each with clear pros/cons): a managed prebuilt-binary download, the
// official curl installer, manual guidance, or detecting an existing binary.

import * as vscode from "vscode";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as https from "node:https";
import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { piLog, piWarn } from "./logger.js";
import { refreshRuntimeContext } from "./runtime-detection.js";
import { detectRustBinary } from "./rust-resolver.js";
import { detectMissingRustTools, installCommandForPlatform, RUST_DEPS_DOCS_URL } from "./rust-deps.js";
import pinnedRust from "./rust-pi-version.json";

const execFileP = promisify(execFile);
const REPO = "Dicklesworthstone/pi_agent_rust";
// Pin the managed download to the release we test against (src/rust-pi-version.json)
// rather than "latest" — auto-installing a moving upstream target is the footgun
// we deliberately avoid. The pin is bumped via .github/workflows/update-rust-pi.yml.
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/tags/${pinnedRust.tag}`;

type Method = "managed" | "curl" | "manual" | "detect";

/** Interactive Rust Pi install. Returns true if a runnable binary ended up present. */
export async function installRustInteractive(context: vscode.ExtensionContext): Promise<boolean> {
  const preferred = vscode.workspace.getConfiguration("pi-code-gui").get<string>("rustInstallMethod") ?? "managed";
  const items: Array<vscode.QuickPickItem & { id: Method }> = [
    { label: "$(cloud-download) Managed download (recommended)", detail: "Download the verified prebuilt binary from GitHub releases into an extension-managed location. No PATH changes, no remote scripts.", id: "managed" },
    { label: "$(terminal) Official installer (curl | sh)", detail: "Easiest; sets up PATH automatically. May rename an existing TypeScript `pi` command to `legacy-pi`.", id: "curl" },
    { label: "$(book) Guide me (manual)", detail: "Open the install instructions; the extension detects the binary afterward.", id: "manual" },
    { label: "$(search) Detect an existing binary", detail: "Look on PATH and common locations (~/.cargo/bin, ~/.local/bin, /usr/local/bin).", id: "detect" },
  ];
  items.sort((a, b) => (a.id === preferred ? -1 : b.id === preferred ? 1 : 0));

  const pick = await vscode.window.showQuickPick(items, { placeHolder: "How do you want to install Rust Pi?", ignoreFocusOut: true });
  if (!pick) { return false; }
  switch (pick.id) {
    case "managed": return managedDownloadRust(context);
    case "curl": return curlInstallRust();
    case "manual": return manualInstallRust();
    case "detect": return detectAndRefresh();
  }
}

/** Map the current platform to its release asset + extracted binary name. */
function platformAsset(): { archive: string; binName: string } | null {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null;
  if (!arch) { return null; }
  const binName = process.platform === "win32" ? "pi.exe" : "pi";
  if (process.platform === "linux") { return { archive: `pi-linux-${arch}.tar.xz`, binName }; }
  if (process.platform === "darwin") { return { archive: `pi-darwin-${arch}.tar.xz`, binName }; }
  if (process.platform === "win32") { return { archive: `pi-windows-${arch}.zip`, binName }; }
  return null;
}

async function managedDownloadRust(context: vscode.ExtensionContext): Promise<boolean> {
  const asset = platformAsset();
  if (!asset) {
    vscode.window.showErrorMessage(`No prebuilt Rust Pi binary for ${process.platform}/${process.arch}. Try the official installer or build from source.`);
    return false;
  }
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Installing Rust Pi…", cancellable: false },
    async (progress) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rustpi-"));
      try {
        progress.report({ message: `Resolving release ${pinnedRust.tag}…` });
        const release = await fetchJson(RELEASES_API);
        const tag = String(release.tag_name ?? pinnedRust.tag);
        const assets = (release.assets ?? []) as Array<{ name: string; browser_download_url: string }>;
        const binAsset = assets.find((a) => a.name === asset.archive);
        const sumsAsset = assets.find((a) => a.name === "SHA256SUMS");
        if (!binAsset) { throw new Error(`Release ${tag} has no asset ${asset.archive}`); }

        const archivePath = path.join(tmp, asset.archive);
        progress.report({ message: `Downloading ${asset.archive}…` });
        await download(binAsset.browser_download_url, archivePath);

        // A release with no SHA256SUMS asset must be a hard failure, not a silent
        // skip: the managed-install path promises a verified binary, so running an
        // unverifiable one would break that contract.
        if (!sumsAsset) {
          throw new Error(`Release ${tag} has no SHA256SUMS asset — refusing to install an unverified binary.`);
        }
        progress.report({ message: "Verifying checksum…" });
        const sumsPath = path.join(tmp, "SHA256SUMS");
        await download(sumsAsset.browser_download_url, sumsPath);
        if (!verifyChecksum(archivePath, asset.archive, sumsPath)) {
          throw new Error("Checksum verification failed — aborting.");
        }

        progress.report({ message: "Extracting…" });
        await execFileP("tar", [asset.archive.endsWith(".zip") ? "-xf" : "-xJf", archivePath, "-C", tmp]);
        const extracted = findFile(tmp, asset.binName);
        if (!extracted) { throw new Error(`Archive did not contain ${asset.binName}`); }

        const binDir = path.join(context.globalStorageUri.fsPath, "rust-pi");
        fs.mkdirSync(binDir, { recursive: true });
        const dest = path.join(binDir, asset.binName);
        fs.copyFileSync(extracted, dest);
        fs.chmodSync(dest, 0o755);

        await vscode.workspace.getConfiguration("pi-code-gui").update("rustBinaryPath", dest, vscode.ConfigurationTarget.Global);
        piLog(`Managed Rust install: placed binary at ${dest}`);

        const status = detectRustBinary();
        if (!status.installed) {
          vscode.window.showWarningMessage(
            `Rust Pi was downloaded to ${dest} but didn't run (it may need a newer system library). Try the official installer instead.`,
          );
          return false;
        }
        await refreshRuntimeContext(true);
        vscode.window.showInformationMessage(`Rust Pi ${status.version ?? tag} installed.`);
        // The binary alone isn't enough: its find/grep tools need fd/rg, which
        // upstream documents as prerequisites but doesn't install. The user just
        // opted into Rust, so offer the documented install now.
        await ensureRustToolDeps();
        return true;
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`Rust Pi install failed: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    },
  );
}

/** After a managed Rust install, ensure rust-pi's find/grep tool deps (fd, rg)
 *  are present; offer the documented install in a terminal if not. No-op when
 *  present, or when the user has them already. */
async function ensureRustToolDeps(): Promise<void> {
  const missing = await detectMissingRustTools();
  if (missing.length === 0) { return; }
  piWarn(`Rust Pi tool deps missing: ${missing.map((d) => d.cmds[0]).join(", ")} — find/grep tools will fail until installed`);
  const names = missing.map((d) => `\`${d.cmds[0]}\` (${d.tool} tool)`).join(" and ");
  const verb = missing.length > 1 ? "aren't" : "isn't";
  const cmd = installCommandForPlatform(missing, process.platform);
  const actions = cmd ? ["Install", "Show docs"] : ["Show docs"];
  const choice = await vscode.window.showWarningMessage(
    `Rust Pi needs ${names}, which ${verb} installed — its find/grep tools will fail until added.`,
    ...actions,
  );
  if (choice === "Install" && cmd) {
    const term = vscode.window.createTerminal("Rust Pi: install tools");
    term.show();
    term.sendText(cmd);
    term.sendText('echo "Done — reload the VS Code window, then start a new Rust session."');
  } else if (choice === "Show docs") {
    void vscode.env.openExternal(vscode.Uri.parse(RUST_DEPS_DOCS_URL));
  }
}

function curlInstallRust(): Promise<boolean> {
  const term = vscode.window.createTerminal("Rust Pi Install");
  term.show();
  term.sendText(`curl -fsSL "https://raw.githubusercontent.com/${REPO}/main/install.sh" | bash`);
  term.sendText('echo "Rust Pi installer finished. Reload VS Code to use it."');
  void vscode.window
    .showInformationMessage("Installing Rust Pi… Reload VS Code after the terminal finishes.", "Reload Now")
    .then((a) => { if (a === "Reload Now") { void vscode.commands.executeCommand("workbench.action.reloadWindow"); } });
  return Promise.resolve(true);
}

async function manualInstallRust(): Promise<boolean> {
  await vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${REPO}#installation`));
  const a = await vscode.window.showInformationMessage("After installing Rust Pi, click Detect to start using it.", "Detect");
  return a === "Detect" ? detectAndRefresh() : false;
}

async function detectAndRefresh(): Promise<boolean> {
  const status = detectRustBinary();
  if (status.installed) {
    await refreshRuntimeContext(true);
    vscode.window.showInformationMessage(`Rust Pi ${status.version ?? ""} detected.`);
    return true;
  }
  vscode.window.showWarningMessage("No Rust Pi binary found. Set `pi-code-gui.rustBinaryPath` or install it.");
  return false;
}

// ── Low-level helpers ──────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "pi-code-gui", Accept: "application/vnd.github+json" } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} for ${url}`)); return; }
      let data = "";
      res.setEncoding("utf-8");
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

function download(url: string, dest: string, redirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, { headers: { "User-Agent": "pi-code-gui" } }, (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        file.close();
        if (redirects <= 0) { reject(new Error("Too many redirects")); return; }
        download(res.headers.location, dest, redirects - 1).then(resolve, reject);
        return;
      }
      if (code !== 200) { res.resume(); file.close(); reject(new Error(`HTTP ${code} for ${url}`)); return; }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", (e) => { file.close(); reject(e); });
    }).on("error", (e) => { file.close(); reject(e); });
  });
}

function verifyChecksum(file: string, name: string, sumsPath: string): boolean {
  const sums = fs.readFileSync(sumsPath, "utf-8");
  // SHA256SUMS lines are "<hex>  <name>" (the name may carry a leading "*" in
  // binary mode). Match the filename field EXACTLY — a substring match could
  // grab a sibling entry such as "<name>.sig" and verify against the wrong hash.
  const line = sums.split("\n").find((l) => {
    const parts = l.trim().split(/\s+/);
    return parts.length >= 2 && parts[parts.length - 1].replace(/^\*/, "") === name;
  });
  // A SHA256SUMS that omits this asset must be a hard failure, not a silent pass:
  // the caller and the "Verifying checksum…" UI both treat `true` as verified.
  if (!line) { piWarn(`No checksum entry for ${name} in SHA256SUMS — refusing to trust the download.`); return false; }
  const expected = line.trim().split(/\s+/)[0];
  const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (expected !== actual) { piWarn(`Checksum mismatch for ${name}: expected ${expected}, got ${actual}`); }
  return expected === actual;
}

function findFile(dir: string, name: string): string | null {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === name) { return full; }
    if (e.isDirectory()) { const r = findFile(full, name); if (r) { return r; } }
  }
  return null;
}
