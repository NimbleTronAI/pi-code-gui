// Pure, vscode-free semver-ish comparison for the pi-ai SDK version gate. Just
// enough to compare major.minor.patch (pre-release/build metadata and a leading
// "v" are ignored); missing or non-numeric components read as 0.

/** Parse "1.2.3" / "v0.80.2-beta.1" → [1,2,3] / [0,80,2]. Lenient: bad input → [0,0,0]. */
export function parseSemver(version: string): [number, number, number] {
  const core = String(version ?? "").trim().replace(/^v/i, "").split(/[-+]/, 1)[0] ?? "";
  const parts = core.split(".");
  const n = (i: number): number => {
    const v = Number.parseInt(parts[i] ?? "", 10);
    return Number.isFinite(v) && v >= 0 ? v : 0;
  };
  return [n(0), n(1), n(2)];
}

/** -1 / 0 / 1 for a<b / a==b / a>b across major.minor.patch. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a), pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) { return -1; }
    if (pa[i] > pb[i]) { return 1; }
  }
  return 0;
}

/** True when `installed` is strictly older than `minimum`. */
export function isOlderThan(installed: string, minimum: string): boolean {
  return compareSemver(installed, minimum) < 0;
}
