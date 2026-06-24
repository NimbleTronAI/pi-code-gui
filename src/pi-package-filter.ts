// Pure, vscode-free predicate for "is this npm package a Pi coding-agent
// extension?". Extracted from pi-package-service.ts so the marketplace keyword
// filter can be unit-tested — it previously matched any keyword CONTAINING "pi"
// (`includes("pi")`), so "api", "scipy", "compiler", "happy"… all looked like Pi
// packages.

/** True only for genuine Pi-ecosystem keywords: exactly "pi", "pi-coding-agent",
 *  or a "pi-"-prefixed keyword (e.g. "pi-web-access"). Case/space tolerant. NOT a
 *  substring match — "api"/"scipy"/"pip" do not match. */
export function matchesPiKeyword(keyword: string): boolean {
  const k = keyword.toLowerCase().trim();
  return k === "pi" || k === "pi-coding-agent" || k.startsWith("pi-");
}

export interface PiPackageFields {
  name?: string;
  description?: string;
  keywords?: string[];
}

/** Heuristic: does this npm package look like a Pi coding-agent extension?
 *  A pi-prefixed/-pi- name, a genuine pi keyword, or a pi-agent description. */
export function isPiMarketplacePackage(pkg: PiPackageFields): boolean {
  const name = (pkg.name ?? "").toLowerCase();
  const desc = (pkg.description ?? "").toLowerCase();
  const keywords = pkg.keywords ?? [];
  return (
    name.startsWith("pi-") ||
    name.includes("-pi-") ||
    keywords.some(matchesPiKeyword) ||
    desc.includes("pi coding agent") ||
    desc.includes("pi agent") ||
    desc.includes("pi extension")
  );
}
