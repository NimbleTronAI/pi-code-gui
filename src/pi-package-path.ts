// Pure, vscode-free resolution of the bundled Pi coding-agent SDK package dir.
// Extracted from pi-service.ts (which imports vscode) so the candidate ORDERING
// — the part that's easy to get subtly wrong, e.g. picking a stale node's copy
// when several NVM versions have the SDK — can be unit-tested headlessly. All
// env/fs inputs are injected; the thin wrapper in pi-service supplies the real ones.

import * as path from "node:path";

const PKG_SUFFIX = path.join("node_modules", "@earendil-works", "pi-coding-agent");

export interface PiPackageCandidateInputs {
  /** process.platform */
  platform: NodeJS.Platform;
  /** process.env.PATH */
  pathEnv: string;
  /** process.env.APPDATA (Windows npm default) */
  appData?: string;
  /** process.env.HOME || process.env.USERPROFILE */
  home?: string;
  /** process.env.NVM_DIR */
  nvmDir?: string;
  /** Version directory names under `$NVM_DIR/versions/node` (caller lists them). */
  nvmVersions?: string[];
}

/**
 * Build the ORDERED, de-duplicated list of candidate package directories to
 * probe, highest priority first: project-local → $PATH-derived global prefixes →
 * Windows AppData → home fallbacks → NVM-managed node versions. NVM versions are
 * ordered **newest-first** (numeric, descending) so a stale node's copy isn't
 * preferred over a newer one when several have the SDK installed.
 */
export function buildPiPackageCandidates(i: PiPackageCandidateInputs): string[] {
  const candidates = new Set<string>();
  const isWin = i.platform === "win32";

  // 1. Project-local install
  candidates.add(path.resolve(path.join(".pi", "npm", PKG_SUFFIX)));

  // 2. PATH scan — derive npm global prefixes from $PATH entries
  const separator = isWin ? ";" : ":";
  const seenPrefixes = new Set<string>();
  for (const binDir of (i.pathEnv || "").split(separator)) {
    if (!binDir) { continue; }
    let normBin = path.normalize(binDir);
    if (normBin.endsWith(path.sep)) { normBin = normBin.slice(0, -1); }
    if (seenPrefixes.has(normBin)) { continue; }
    seenPrefixes.add(normBin);
    const prefix = path.dirname(normBin);
    candidates.add(path.join(prefix, "lib", PKG_SUFFIX));
    if (isWin) { candidates.add(path.join(prefix, PKG_SUFFIX)); }
  }

  // 3. Windows AppData (npm default on Windows)
  if (i.appData) { candidates.add(path.join(i.appData, "npm", PKG_SUFFIX)); }

  // 4. Home fallbacks (for GUI-launched VS Code with an incomplete $PATH)
  if (i.home) {
    candidates.add(path.join(i.home, ".npm-global", "lib", PKG_SUFFIX));
    candidates.add(path.join(i.home, ".local", "lib", PKG_SUFFIX));
  }

  // 5. NVM-managed node versions, newest first (avoids a stale-version pick)
  if (i.nvmDir && i.nvmVersions && i.nvmVersions.length > 0) {
    const versionsBase = path.join(i.nvmDir, "versions", "node");
    const ordered = [...i.nvmVersions].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of ordered) {
      candidates.add(path.join(versionsBase, v, "lib", PKG_SUFFIX));
    }
  }

  return [...candidates];
}

/** Return the first candidate whose `package.json` exists (per `exists`), or null.
 *  `exists` is passed the full `package.json` path; a throwing probe is skipped. */
export function pickPiPackagePath(candidates: string[], exists: (pkgJsonPath: string) => boolean): string | null {
  for (const candidate of candidates) {
    try {
      if (exists(path.join(candidate, "package.json"))) { return candidate; }
    } catch { /* skip a bad candidate */ }
  }
  return null;
}
