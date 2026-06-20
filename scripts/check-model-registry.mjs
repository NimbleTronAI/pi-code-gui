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
if (!existsSync(pkgPath)) { fail("@earendil-works/pi-ai isn't installed (devDependency) — run a fresh install"); }

const stamped = JSON.parse(readFileSync(genPath, "utf8")).piAiVersion;
const installed = JSON.parse(readFileSync(pkgPath, "utf8")).version;

if (stamped !== installed) {
  fail(`generated from pi-ai ${stamped}, but ${installed} is installed (a Dependabot bump?)`);
}
console.log(`model-registry.generated.json is in sync with pi-ai ${installed}`);
