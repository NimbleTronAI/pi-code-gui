// Regenerate media/architecture.png from media/architecture.svg (the single
// source of truth) and stamp the source hash so check-diagram can detect drift.
//
//   npm run gen:diagram   ← run this after editing the SVG, then commit both files.
//
// Uses @resvg/resvg-js (a real SVG renderer, bundled prebuilt — no system deps),
// so it's portable and pixel-accurate: the SVG only references DejaVu Sans /
// DejaVu Sans Mono, which resvg resolves from system fonts. The build does NOT
// call this; it only calls check-diagram, which is pure Node.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svgPath = join(root, "media", "architecture.svg");
const pngPath = join(root, "media", "architecture.png");
const stamp = join(root, "media", "architecture.gen.json");

const svg = readFileSync(svgPath);
const sha = createHash("sha256").update(svg).digest("hex");

// The SVG viewBox is 760x480; render at 2x for a crisp README image. The SVG
// carries its own (dark) background, so it fills the whole canvas.
const resvg = new Resvg(svg, {
  fitTo: { mode: "zoom", value: 2 },
  font: { loadSystemFonts: true },
});
const png = resvg.render().asPng();
writeFileSync(pngPath, png);

writeFileSync(stamp, JSON.stringify({
  note: "architecture.png is generated from architecture.svg by `npm run gen:diagram`. Do NOT hand-edit the PNG — edit the SVG and regenerate.",
  source: "architecture.svg",
  sourceSha256: sha,
  generator: "@resvg/resvg-js (fitTo zoom 2x)",
}, null, 2) + "\n");

console.log(`Generated media/architecture.png from architecture.svg via resvg (svg sha256 ${sha.slice(0, 12)}…), ${png.length} bytes`);
