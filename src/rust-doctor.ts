// Pure, vscode-free interpretation of a `rust-pi doctor <path>` run. Extracted
// from rust-packages.ts (which imports vscode transitively) so the verdict
// precedence can be unit-tested — note "incompatible" CONTAINS "compatible", so
// the order of the checks below is load-bearing.

/**
 * Whether the Rust runtime can load the extension `doctor` examined. A hard
 * `[FAIL]` or an explicit "incompatible" means no; an explicit "compatible"
 * means yes; with no verdict in the output, fall back to the process exit code.
 */
export function parseDoctorVerdict(stdout: string, exitCode: number): boolean {
  if (/\[FAIL\]/.test(stdout)) { return false; }
  if (/incompatible/i.test(stdout)) { return false; } // MUST precede the /compatible/ check
  if (/compatible/i.test(stdout)) { return true; }
  return exitCode === 0;
}
