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
import { piLog, piWarn, revealLog } from "./logger.js";
import { refreshRuntimeContext } from "./runtime-detection.js";
import {
  detectRustBinary, detectRustBinaryExcludingManaged, invalidateRustBinaryCache, firstLine, isInsideManaged,
  managedRustBinary, removeManagedRustBinary, type RustInstallStatus,
} from "./rust-resolver.js";
import { detectMissingRustTools } from "./rust-deps.js";
import pinnedRust from "./rust-pi-version.json";

const execFileP = promisify(execFile);
const REPO = "Dicklesworthstone/pi_agent_rust";
// Pin the managed download to the release we test against (src/rust-pi-version.json)
// rather than "latest" — auto-installing a moving upstream target is the footgun
// we deliberately avoid. The pin is bumped by editing src/rust-pi-version.json (there is no
// automated bump workflow — the file's own _comment describes what a Renovate rule would need).
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/tags/${pinnedRust.tag}`;

type Method = "managed" | "curl" | "manual" | "detect";

/** Interactive Rust Pi install. Returns true if a runnable binary ended up present. */
export async function installRustInteractive(context: vscode.ExtensionContext): Promise<boolean> {
  const preferred = vscode.workspace.getConfiguration("pi-code-gui").get<string>("rustInstallMethod") ?? "managed";
  const items: Array<vscode.QuickPickItem & { id: Method }> = [
    // Each option states its OWN downside explicitly. The two risks are disjoint and the copy
    // used to leave that to inference: "No PATH changes, no remote scripts" only answers "does
    // the managed option also rename my pi?" if you notice it is a rebuttal of the next line.
    // Say it outright — that question is the whole basis for choosing between them.
    { label: "$(cloud-download) Managed download (recommended)", detail: "Checksum-verified binary into extension-managed storage. Leaves PATH alone and does NOT touch an existing `pi` command. Risk: may not run against older system libraries — detected on install, with a fallback offered.", id: "managed" },
    { label: "$(terminal) Official installer (curl | sh)", detail: "Runs the upstream install.sh from GitHub and sets up PATH for you. Risk: executes a remote script, and MAY RENAME an existing TypeScript `pi` command to `legacy-pi`.", id: "curl" },
    { label: "$(book) Guide me (manual)", detail: "Open the install instructions; the extension detects the binary afterward.", id: "manual" },
    { label: "$(search) Detect an existing binary", detail: "Use a Rust Pi you installed yourself (~/.cargo/bin, ~/.local/bin, /usr/local/bin, PATH). If one runs, the extension-managed copy is removed so it no longer takes precedence.", id: "detect" },
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
  const placed = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Installing Rust Pi…", cancellable: true },
    async (progress, token): Promise<{ dest: string; tag: string } | null> => {
      // Abort in-flight network requests when the user cancels (and the socket
      // timeout backstops a silent stall — see NET_TIMEOUT_MS).
      const ac = new AbortController();
      token.onCancellationRequested(() => ac.abort());
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rustpi-"));
      try {
        progress.report({ message: `Resolving release ${pinnedRust.tag}…` });
        const release = await fetchJson(RELEASES_API, ac.signal);
        const tag = String(release.tag_name ?? pinnedRust.tag);
        const assets = (release.assets ?? []) as Array<{ name: string; browser_download_url: string }>;
        const binAsset = assets.find((a) => a.name === asset.archive);
        // EVERY SHA256SUMS* asset, not just the exact name. A release can carry its checksums
        // split across several files: v0.1.23 shipped 3 binaries on day one, then added
        // pi-linux-arm64 / pi-darwin-amd64 a week later with their hashes in a SEPARATE
        // "SHA256SUMS.issue-146", leaving the original SHA256SUMS untouched. Reading only the
        // exact name found no entry for the arm64 archive and failed it as
        // "Checksum verification failed" — which reads as tampering when the hash was merely
        // in the sibling file. Same trust boundary either way: every one of these is an asset
        // on the same release, fetched over HTTPS from the same origin.
        const sumsAssets = assets.filter((a) => a.name === "SHA256SUMS" || a.name.startsWith("SHA256SUMS."));
        if (!binAsset) { throw new Error(`Release ${tag} has no asset ${asset.archive}`); }

        const archivePath = path.join(tmp, asset.archive);
        progress.report({ message: `Downloading ${asset.archive}…` });
        await download(binAsset.browser_download_url, archivePath, ac.signal);

        // A release with no SHA256SUMS asset must be a hard failure, not a silent
        // skip: the managed-install path promises a verified binary, so running an
        // unverifiable one would break that contract.
        if (sumsAssets.length === 0) {
          throw new Error(`Release ${tag} has no SHA256SUMS asset — refusing to install an unverified binary.`);
        }
        progress.report({ message: "Verifying checksum…" });
        const sumsPath = path.join(tmp, "SHA256SUMS");
        const chunks: string[] = [];
        for (const [i, s] of sumsAssets.entries()) {
          const part = path.join(tmp, `SHA256SUMS.part${i}`);
          await download(s.browser_download_url, part, ac.signal);
          chunks.push(fs.readFileSync(part, "utf-8"));
        }
        fs.writeFileSync(sumsPath, chunks.join("\n"));
        if (!verifyChecksum(archivePath, asset.archive, sumsPath)) {
          throw new Error(
            `Checksum verification failed for ${asset.archive} — aborting. ` +
            `(Checked ${sumsAssets.length} checksum file(s): ${sumsAssets.map((s) => s.name).join(", ")}.)`,
          );
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

        // Verify THE BINARY WE JUST WROTE before declaring it installed.
        //
        // This is not an edge case on Linux. Upstream builds on a bleeding-edge toolchain and the
        // glibc floor moves between releases: v0.3.0 needs GLIBC_2.39, v0.5.1 needs 2.43
        // (measured with objdump -T). 2.39 already excludes Ubuntu 22.04 LTS (2.35) and Debian 12
        // (2.36); 2.43 excludes nearly every shipping distro. A user on one of those gets a
        // binary that cannot exec, and before this check the failure surfaced two steps later as
        // a 15-second RPC timeout naming get_state.
        //
        // This used to set rustBinaryPath first and then call detectRustBinary() to check it,
        // which cannot work: detection walks every candidate and SKIPS one whose `--version`
        // fails, so it answered "is any working binary findable?" — and happily found an
        // unrelated older `pi` elsewhere on the box. Live consequence, measured: v0.5.1's Linux
        // binaries need GLIBC_2.43 (v0.3.0 needed 2.39). On a glibc-2.41 host the download could
        // not exec at all, yet the install reported "Rust Pi 0.3.0 installed" — the version of a
        // DIFFERENT binary — left rustBinaryPath pointing at the unrunnable one, and the
        // "may need a newer system library" warning never fired. Probe `dest` itself.
        try {
          await execFileP(dest, ["--version"], { timeout: 10_000 });
        } catch (e: unknown) {
          const why = e instanceof Error ? e.message : String(e);
          piWarn(`Managed Rust install: ${dest} will not run: ${why}`);
          try { fs.rmSync(dest, { force: true }); } catch { /* best effort */ }
          const detail = firstLine(why);
          const glibc = /GLIBC_([0-9.]+)/.exec(detail)?.[1];
          void vscode.window.showWarningMessage(
            `Rust Pi ${tag} downloaded but will not run on this machine: ${detail}` +
            (glibc
              ? ` This release needs glibc ${glibc} or newer; run \`ldd --version\` to see what you have. ` +
                `A newer distribution, or building from source, are the only ways to run this release.`
              : ""),
            "Show Log",
          ).then((pick) => { if (pick === "Show Log") { revealLog(); } });
          piWarn(`Managed Rust install: removed ${dest}; it cannot exec on this host (${detail})`);
          return null;
        }

        // The binary is in place and runs. Everything that can prompt the user happens in
        // finishManagedInstall, after the progress notification has closed.
        return { dest, tag };
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`Rust Pi install failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    },
  );
  return placed ? finishManagedInstall(placed.dest, placed.tag) : false;
}

function realpathOr(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/**
 * The tail of a managed install, once the binary is in `<globalStorage>/rust-pi` and answers
 * `--version`. Exported so it is testable without the network.
 *
 * It does NOT write `pi-code-gui.rustBinaryPath`. It used to, with the binary's absolute path —
 * and that machine-scoped setting still reached other machines (observed: a Mac profile's value
 * applied inside a Linux dev container), so every Rust session there warned that the file did not
 * exist. The resolver now finds the managed install itself (setManagedRustDir, from activate()).
 *
 * The one thing the old write did on purpose was make the managed binary beat a DIFFERENT binary
 * the user had configured — by overwriting their setting without asking. Now, when an explicit
 * choice still outranks the managed binary, we say which one, and clear the setting only on the
 * user's click.
 */
export async function finishManagedInstall(dest: string, tag: string): Promise<boolean> {
  piLog(`Managed Rust install: placed binary at ${dest}`);
  invalidateRustBinaryCache();
  let status = detectRustBinary();
  if (!status.installed) {
    vscode.window.showWarningMessage(
      `Rust Pi was downloaded to ${dest} but didn't run (it may need a newer system library). Try the official installer instead.`,
    );
    return false;
  }
  const destReal = realpathOr(dest);
  if (status.binaryPath !== destReal) {
    const cfg = vscode.workspace.getConfiguration("pi-code-gui");
    const configured = cfg.get<string>("rustBinaryPath")?.trim();
    const env = process.env.PI_BINARY_PATH?.trim();
    if (configured && !status.configuredPathError && realpathOr(configured) === status.binaryPath) {
      const USE = "Use Managed Install";
      const pick = await vscode.window.showWarningMessage(
        `Rust Pi ${tag} was installed to ${dest}, but "pi-code-gui.rustBinaryPath" (${configured}) takes precedence, ` +
        `so sessions will keep running ${status.binaryPath}. Clear the setting to use the managed install?`,
        USE, "Keep Setting",
      );
      if (pick === USE) {
        await cfg.update("rustBinaryPath", undefined, vscode.ConfigurationTarget.Global);
        invalidateRustBinaryCache();
        // Machine-scoped, and its value can come from a layer this window cannot clear (a local
        // profile applied in a remote). Never claim a clear that did not happen.
        if (vscode.workspace.getConfiguration("pi-code-gui").get<string>("rustBinaryPath")?.trim()) {
          void vscode.window.showWarningMessage(
            `"pi-code-gui.rustBinaryPath" is still set in another settings layer; remove it there to use the managed install.`,
          );
          void vscode.commands.executeCommand("workbench.action.openSettings", "pi-code-gui.rustBinaryPath");
        }
        status = detectRustBinary();
      }
    } else if (env && realpathOr(env) === status.binaryPath) {
      void vscode.window.showWarningMessage(
        `Rust Pi ${tag} was installed to ${dest}, but the PI_BINARY_PATH environment variable (${env}) takes precedence, ` +
        `so sessions will keep running ${status.binaryPath}. Unset it to use the managed install.`,
      );
    } else {
      void vscode.window.showWarningMessage(
        `Rust Pi ${tag} was installed to ${dest}, but detection chose ${status.binaryPath} instead. See the log for why.`,
        "Show Log",
      ).then((pick) => { if (pick === "Show Log") { revealLog(); } });
    }
  }
  await refreshRuntimeContext(true);
  if (status.binaryPath === destReal) {
    vscode.window.showInformationMessage(
      `Rust Pi ${status.version ?? tag} installed. If you later install Rust Pi another way, ` +
      `run "PiGui: Install Rust Pi" → Detect an existing binary to switch to it.`,
    );
  }
  // The binary alone isn't enough: its find/grep tools need fd/rg, which
  // upstream documents as prerequisites but doesn't install. The user just
  // opted into Rust, so offer the documented install now.
  await ensureRustToolDeps();
  return true;
}

/** After a managed Rust install, check rust-pi's find/grep tool deps (fd, rg) and,
 *  if any are missing, point the user at each tool's own install guide (the
 *  authoritative per-OS matrix). No-op when they're already present. Docs-only: we
 *  don't synthesize a package-manager command — see rust-deps.ts for why. */
async function ensureRustToolDeps(): Promise<void> {
  const missing = await detectMissingRustTools();
  if (missing.length === 0) { return; }
  piWarn(`Rust Pi tool deps missing: ${missing.map((d) => d.cmds[0]).join(", ")} — find/grep tools will fail until installed`);
  const names = missing.map((d) => `${d.cmds[0]} (${d.tool} tool)`).join(" and ");
  const verb = missing.length > 1 ? "aren't" : "isn't";
  // One button per missing tool, opening that tool's install guide for the user's OS.
  const buttons = missing.map((d) => `${d.cmds[0]} install guide`);
  const choice = await vscode.window.showWarningMessage(
    `Rust Pi needs ${names}, which ${verb} installed — its find/grep tools will fail until added. See each tool's install guide for your OS.`,
    ...buttons,
  );
  const picked = missing.find((d) => choice === `${d.cmds[0]} install guide`);
  if (picked) { void vscode.env.openExternal(vscode.Uri.parse(picked.docs)); }
}

async function curlInstallRust(): Promise<boolean> {
  const term = vscode.window.createTerminal("Rust Pi Install");
  term.show();
  // Pin the installer to the SAME tag the extension is built and tested against, rather than
  // whatever `main` happens to be. The managed path verifies SHA256SUMS and hard-fails without
  // them; this path can't (it is the upstream installer), so at minimum it must not float.
  term.sendText(`curl -fsSL "https://raw.githubusercontent.com/${REPO}/${pinnedRust.tag}/install.sh" | bash`);
  term.sendText('echo "Rust Pi installer finished. Click Detect in the notification (or run PiGui: Install Rust Pi -> Detect an existing binary)."');
  // rust-pi's find/grep tools also need fd/rg, which it doesn't install. Offer
  // them now (independent of the curl install running in the terminal above).
  await ensureRustToolDeps();
  void afterCurlInstall();
  return true;
}

/**
 * The curl flow's closing notification. The extension cannot see when (or whether) the installer
 * in the terminal finished, so switching waits for the user's Detect click — which verifies the
 * new binary runs before removing the managed copy (detectAndRefresh). A reload alone would not
 * switch: a managed binary still outranks the common locations and PATH. Exported for tests.
 */
export async function afterCurlInstall(): Promise<boolean> {
  const pick = await vscode.window.showInformationMessage(
    "Installing Rust Pi in the terminal. When it finishes, click Detect to switch to it.",
    "Detect",
  );
  return pick === "Detect" ? detectAndRefresh({ offerReload: true }) : false;
}

async function manualInstallRust(): Promise<boolean> {
  await vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${REPO}#installation`));
  const a = await vscode.window.showInformationMessage("After installing Rust Pi, click Detect to start using it.", "Detect");
  return a === "Detect" ? detectAndRefresh() : false;
}

/** First whitespace-separated token of a `--version` line: the program's own name. */
const firstToken = (v: string | undefined): string | undefined => v?.trim().split(/\s+/)[0] || undefined;

/**
 * Why `other` must NOT replace the managed binary, or undefined when it may (review of record
 * SF2): its `--version` must name the same program as the managed binary's, and it must not be
 * the managed file itself under another name (same dev+inode — a hard link, or a case-only alias
 * on a case-insensitive filesystem).
 */
function replacementMismatch(other: RustInstallStatus, managed: RustInstallStatus, managedBin: string): string | undefined {
  const otherPath = other.binaryPath ?? "";
  const statOr = (f: string): fs.Stats | undefined => { try { return fs.statSync(f); } catch { return undefined; } };
  const a = statOr(otherPath);
  const b = statOr(managedBin);
  if (!a || !b) {
    return `Found ${otherPath}, but it or the extension-managed install at ${managedBin} could not be inspected; nothing was removed.`;
  }
  if (a.dev === b.dev && a.ino === b.ino) {
    return `Found ${otherPath}, but it is the same file as the extension-managed install at ${managedBin}; nothing was removed.`;
  }
  const want = firstToken(managed.version);
  if (!want || firstToken(other.version) !== want) {
    const line = (other.version ?? "").split("\n")[0].trim();
    return `Found ${otherPath}, but its --version ("${line}") does not identify as Rust Pi; the extension-managed install was kept.`;
  }
  return undefined;
}

/**
 * "Detect an existing binary" (also the manual flow's and the curl flow's Detect button).
 *
 * Founder's option "c": choosing a self-installed binary here is the explicit moment to drop the
 * extension's own managed copy, so no leftover keeps outranking it. Order, strictly:
 *   full detect → only if the MANAGED binary is the one winning → detect with it excluded (each
 *   candidate accepted only after `--version` succeeds) → remove ONLY `<managedDir>/pi[.exe]` →
 *   invalidate → refreshRuntimeContext(true) → notice.
 * When the setting or PI_BINARY_PATH already outranks the managed binary, nothing is removed (a
 * status check must not delete the user's fallback). When nothing else runs, the managed binary
 * is kept. Exported for tests.
 */
export async function detectAndRefresh(opts: { offerReload?: boolean } = {}): Promise<boolean> {
  invalidateRustBinaryCache();
  let status = detectRustBinary();
  let notice: string | undefined;
  let warning: string | undefined; // why the managed binary was kept although another was found
  const managedBin = managedRustBinary();
  // Only when THE managed binary is the winner (not some other file a user put in that folder).
  if (status.installed && managedBin && status.binaryPath === realpathOr(managedBin)) {
    const other = detectRustBinaryExcludingManaged();
    // SF2 (unit 4c): only a binary that identifies as the same program, and is not the managed
    // file itself under another name, justifies removing a working Rust Pi.
    const mismatch = other.installed && other.binaryPath ? replacementMismatch(other, status, managedBin) : undefined;
    if (mismatch) {
      piWarn(`detectAndRefresh: managed binary kept: ${mismatch}`);
      warning = mismatch;
    } else if (other.installed && other.binaryPath) {
      // A setting that is a symlink (or other alias) to the managed binary dangles after removal and
      // would warn every session; say so. The literal managed path is skipped quietly (S1 (i)).
      const configured = vscode.workspace.getConfiguration("pi-code-gui").get<string>("rustBinaryPath")?.trim();
      const aliased = !!configured && path.resolve(configured) !== managedBin && isInsideManaged(configured);
      const r = removeManagedRustBinary();
      if (r && "removed" in r) {
        invalidateRustBinaryCache();
        status = detectRustBinary();
        notice =
          `Rust Pi now uses ${status.binaryPath}${status.version ? ` (${status.version})` : ""}. ` +
          `The extension-managed copy at ${r.removed} was removed so it no longer takes precedence; ` +
          `open Rust sessions keep their binary until reopened. To get it back, run "PiGui: Install Rust Pi" → Managed download. ` +
          `After a curl install run by hand in a terminal, run "PiGui: Install Rust Pi" → Detect an existing binary to switch the same way.` +
          (aliased ? ` "pi-code-gui.rustBinaryPath" (${configured}) pointed at it; clear it.` : "");
      } else if (r && "error" in r) {
        piWarn(`detectAndRefresh: could not remove the managed binary: ${r.error}`);
        warning = r.refused
          ? `Found Rust Pi at ${other.binaryPath}, but nothing was removed: ${r.error}. ` +
            `The extension-managed install still takes precedence.`
          : `Found Rust Pi at ${other.binaryPath}, but the extension-managed copy at ${managedBin} could not be removed (${r.error}), ` +
            `so it still takes precedence. Close Rust sessions and run Detect again.`;
      }
    }
  }
  if (status.installed) {
    await refreshRuntimeContext(true);
    if (notice) {
      vscode.window.showInformationMessage(notice);
    } else if (warning) {
      void vscode.window.showWarningMessage(warning);
    } else {
      const managed = !!status.binaryPath && isInsideManaged(status.binaryPath);
      vscode.window.showInformationMessage(
        `Rust Pi ${status.version ?? ""} detected at ${status.binaryPath}` +
        (managed ? " (the extension-managed install; no other runnable Rust Pi was found)." : "."),
      );
    }
    // Covers both the detect path and the manual path (which routes here): make
    // sure rust-pi's find/grep deps (fd, rg) are present, same as managed install.
    await ensureRustToolDeps();
    return true;
  }
  const msg = "No Rust Pi binary found. Set `pi-code-gui.rustBinaryPath` or install it.";
  if (opts.offerReload) {
    // After a terminal install the extension host's PATH predates it; a reload picks it up.
    const RELOAD = "Reload Window";
    const pick = await vscode.window.showWarningMessage(msg, RELOAD);
    if (pick === RELOAD) { void vscode.commands.executeCommand("workbench.action.reloadWindow"); }
  } else {
    vscode.window.showWarningMessage(msg);
  }
  return false;
}

// ── Low-level helpers ──────────────────────────────────

// Per-request inactivity timeout so a stalled CDN / hung TCP connection can't
// freeze the install dialog indefinitely. `signal` lets the cancellable progress
// abort an in-flight request.
const NET_TIMEOUT_MS = 15000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fetchJson(url: string, signal?: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "pi-code-gui", Accept: "application/vnd.github+json" }, signal }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} for ${url}`)); return; }
      let data = "";
      res.setEncoding("utf-8");
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.setTimeout(NET_TIMEOUT_MS, () => req.destroy(new Error(`Timed out fetching ${url}`)));
    req.on("error", reject);
  });
}

function download(url: string, dest: string, signal?: AbortSignal, redirects = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { "User-Agent": "pi-code-gui" }, signal }, (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        file.close();
        if (redirects <= 0) { reject(new Error("Too many redirects")); return; }
        download(res.headers.location, dest, signal, redirects - 1).then(resolve, reject);
        return;
      }
      if (code !== 200) { res.resume(); file.close(); reject(new Error(`HTTP ${code} for ${url}`)); return; }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", (e) => { file.close(); reject(e); });
    });
    req.setTimeout(NET_TIMEOUT_MS, () => req.destroy(new Error(`Timed out downloading ${url}`)));
    req.on("error", (e) => { file.close(); reject(e); });
  });
}

export function verifyChecksum(file: string, name: string, sumsPath: string): boolean {
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
