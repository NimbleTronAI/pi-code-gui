import { createRequire } from "node:module";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const require = createRequire(import.meta.url);
// Call VSCE's pack step directly because production bundles were already built.
// This avoids running vscode:prepublish a second time.
const { pack } = require("@vscode/vsce/out/package.js");
const manifest = await Bun.file("package.json").json();
const artifactsDirectory = "artifacts";
const output = join(artifactsDirectory, `${manifest.name}-${manifest.version}.vsix`);

await mkdir(artifactsDirectory, { recursive: true });
await rm(output, { force: true });

const { files, packagePath } = await pack({
  cwd: process.cwd(),
  packagePath: output,
  dependencies: false,
  ignoreFile: ".vscodeignore",
  allowMissingRepository: true,
});

const { size } = await stat(packagePath);
console.log(`Built ${packagePath} (${files.length} files, ${Math.ceil(size / 1024)} KB)`);
