// Fail the build if media/architecture.png is out of sync with architecture.svg.
// Pure Node (no rasterizer), so it runs anywhere — CI without ImageMagick included.
// Wired into the `package`/`vsix` build so a stale PNG can't be shipped.
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = join(root, "media", "architecture.svg");
const png = join(root, "media", "architecture.png");
const stamp = join(root, "media", "architecture.gen.json");

function fail(msg) {
  console.error(`\n  architecture diagram out of sync: ${msg}`);
  console.error("  Edit media/architecture.svg, then run `npm run gen:diagram` and commit the PNG.\n");
  process.exit(1);
}

if (!existsSync(png)) { fail("media/architecture.png is missing"); }
if (!existsSync(stamp)) { fail("media/architecture.gen.json is missing"); }

const sha = createHash("sha256").update(readFileSync(svg)).digest("hex");
const recorded = JSON.parse(readFileSync(stamp, "utf8")).sourceSha256;
if (sha !== recorded) { fail("architecture.svg changed since the PNG was last generated"); }

console.log("architecture.png is in sync with architecture.svg");
