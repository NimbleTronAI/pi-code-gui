// Clear the compiled-output directory before a test compile, WITHOUT destroying the durable
// things that live alongside it.
//
// `compile-tests` used to be `rmSync('out', {recursive: true, force: true})`, which wiped the
// whole directory. `out/` is gitignored, so it is also the natural place to drop analysis
// artefacts — and two of those were destroyed that way: an architecture analysis, and later a
// pair of review reports that had taken two agents a full run to produce, deleted by a routine
// `pnpm run test:unit` moments after they were written. Nothing warned; the compile just
// succeeded and the files were gone.
//
// Anything listed in KEEP survives. Everything else under out/ is build output and is removed.
import { readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Subdirectories of out/ that are NOT build output and must survive a clean. */
const KEEP = new Set(["reviews"]);

const OUT = "out";
if (existsSync(OUT)) {
  for (const entry of readdirSync(OUT, { withFileTypes: true })) {
    if (KEEP.has(entry.name)) { continue; }
    rmSync(join(OUT, entry.name), { recursive: true, force: true });
  }
}
