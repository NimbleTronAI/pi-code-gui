// Fail the build if src/model-registry.generated.json is stale relative to the
// installed @earendil-works/pi-ai. Wired into the `package`/`vsix` build so a
// Dependabot bump of pi-ai breaks the build until the registry is regenerated —
// the enforced "pick up the update" mechanism. Pure Node (no pi-ai import needed).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const genPath = join(root, "src", "model-registry.generated.json");
const pkgPath = join(root, "node_modules", "@earendil-works", "pi-ai", "package.json");

function fail(msg) {
  console.error(`\n  model registry out of sync: ${msg}`);
  console.error("  Run `npm run gen:model-registry` and commit src/model-registry.generated.json.\n");
  process.exit(1);
}

if (!existsSync(genPath)) { fail("src/model-registry.generated.json is missing"); }
const stamped = JSON.parse(readFileSync(genPath, "utf8")).piAiVersion;

// Usable from a BARE CHECKOUT, with no node_modules. release.yml runs this before it tags, and
// that job has no Node setup or install — adding one there to satisfy this check would be a lot
// of machinery for a version string the generated file already carries. Without pi-ai installed
// the consistency check is skipped (there is nothing to compare against) and the currency check
// runs against the stamped version, which is exactly what a release would ship.
const haveInstalled = existsSync(pkgPath);
const installed = haveInstalled ? JSON.parse(readFileSync(pkgPath, "utf8")).version : stamped;

if (haveInstalled && stamped !== installed) {
  fail(`generated from pi-ai ${stamped}, but ${installed} is installed (a Dependabot bump?)`);
}
if (!haveInstalled) {
  console.log(`pi-ai is not installed — checking the catalog stamped at ${stamped} for currency only`);
}

// ── Second question: is what's INSTALLED actually current? ──────────────────
//
// The check above only proves the registry matches the installed pi-ai. Both can be stale
// together, and were: the bundled catalog sat at 0.84.1 while 0.84.4 was published, so the picker
// was missing deepseek-v4-flash-vision-exp while a live read of the SDK had it. This gate passed the whole time, because internal consistency was all it asked.
//
// The dependency range is `^0.84.1`, so a lockfile refresh picks up 0.84.4 on its own and never
// touches package.json — meaning Dependabot has nothing to raise a PR about, and CI's
// --frozen-lockfile keeps the old resolution indefinitely. Nothing in the pipeline was ever
// going to notice.
//
// This matters more than an ordinary stale dependency because the catalog carries PRICING and
// model availability: stale here means quoting rates that no longer exist and hiding models the
// user is paying for.
//
// Network-tolerant by design: a build must not fail because npm is unreachable. Unreachable is a
// warning; a definite answer showing drift is fatal.
// Fatal ONLY where a stale catalog actually reaches users: the publish jobs set
// PI_REGISTRY_CURRENCY_STRICT=1. Everywhere else this warns.
//
// It was fatal everywhere, and that was wrong in a way worth naming. The check depends on what
// UPSTREAM publishes, so a green pipeline turns red with no change to this repo — it took out an
// unrelated Dependabot PR (@types/node, eslint, zod) the day pi-ai 0.85.1 shipped. Three things
// follow from that:
//
//   - The blast radius was wrong. A stale catalog is a defect in the artifact we SHIP, not a
//     reason to block a lint-config bump.
//   - It blocks the people who would fix it, by failing every branch at once.
//   - It would have been routed around. The first time this red-walls a release day, someone
//     sets PI_SKIP_REGISTRY_CURRENCY=1 in CI permanently and the signal is gone for good — worse
//     than the warning it replaced.
//
// The consistency check above stays fatal everywhere: it is deterministic, caused only by our
// own commits (a pi-ai bump without regenerating), and fixable by the person who tripped it.
const SKIP = process.env.PI_SKIP_REGISTRY_CURRENCY === "1";
const STRICT = process.env.PI_REGISTRY_CURRENCY_STRICT === "1";

function cmpSemver(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) { return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1; }
  }
  return 0;
}

async function latestPublished() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);   // never hang a build on the network
  try {
    const res = await fetch("https://registry.npmjs.org/@earendil-works%2Fpi-ai", {
      headers: { accept: "application/vnd.npm.install-v1+json" }, signal: ac.signal,
    });
    if (!res.ok) { return null; }
    return (await res.json())?.["dist-tags"]?.latest ?? null;
  } catch { return null; } finally { clearTimeout(timer); }
}

if (SKIP) {
  console.log(`model-registry.generated.json is in sync with pi-ai ${installed} (currency check skipped)`);
} else {
  const latest = await latestPublished();
  if (!latest) {
    console.log(`model-registry.generated.json is in sync with pi-ai ${installed}`);
    console.log("  note: could not reach npm to check whether that is the current release");
  } else if (cmpSemver(installed, latest) < 0) {
    console.error(`\n  ${STRICT ? "model catalog is STALE" : "WARNING: model catalog is behind"}: pi-ai ${installed} is installed, ${latest} is published.`);
    console.error("  The catalog carries model PRICING and availability, so a stale one quotes rates");
    console.error("  that may no longer exist and hides models you can use.\n");
    console.error("  Fix:  pnpm add -D @earendil-works/pi-ai@latest && npm run gen:model-registry");
    console.error("  Then commit package.json, the lockfile and src/model-registry.generated.json.\n");
    if (STRICT) {
      console.error("  Deliberately pinning? Set PI_SKIP_REGISTRY_CURRENCY=1 for this build.\n");
      process.exit(1);
    }
    console.error("  Not failing this build — only a publish refuses to ship a stale catalog.\n");
  } else {
    console.log(`model-registry.generated.json is in sync with pi-ai ${installed} (current)`);
  }
}
