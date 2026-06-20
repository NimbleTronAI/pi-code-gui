// Regenerate media/architecture.png from media/architecture.svg (the single
// source of truth) and stamp the source hash so check-diagram can detect drift.
//
//   npm run gen:diagram   ← run this after editing the SVG, then commit both files.
//
// Uses ImageMagick (`convert`) — install it if missing. The build does NOT call
// this (so CI needs no rasterizer); it only calls check-diagram, which is pure Node.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = join(root, "media", "architecture.svg");
const png = join(root, "media", "architecture.png");
const stamp = join(root, "media", "architecture.gen.json");

const sha = createHash("sha256").update(readFileSync(svg)).digest("hex");

try {
  // The SVG viewBox is 760x480; -density 192 renders it at ~2x (1520x960). The
  // SVG carries its own (dark) background, so -background is just a fallback.
  execFileSync("convert", ["-background", "white", "-density", "192", svg, png], { stdio: "inherit" });
} catch {
  console.error("gen:diagram needs ImageMagick (`convert`) on PATH. Install it, then re-run `npm run gen:diagram`.");
  process.exit(1);
}

writeFileSync(stamp, JSON.stringify({
  note: "architecture.png is generated from architecture.svg by `npm run gen:diagram`. Do NOT hand-edit the PNG — edit the SVG and regenerate.",
  source: "architecture.svg",
  sourceSha256: sha,
  generator: "imagemagick convert -density 192",
}, null, 2) + "\n");

console.log(`Generated media/architecture.png from architecture.svg (svg sha256 ${sha.slice(0, 12)}…)`);
