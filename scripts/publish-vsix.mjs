import { join } from "node:path";

const manifest = await Bun.file("package.json").json();
const packagePath = join("artifacts", `${manifest.name}-${manifest.version}.vsix`);

if (!(await Bun.file(packagePath).exists())) {
  throw new Error(`VSIX not found: ${packagePath}. Run bun run build first.`);
}

const child = Bun.spawn(
  ["bunx", "vsce", "publish", "--packagePath", packagePath, "--skip-duplicate"],
  {
    cwd: process.cwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  },
);

const exitCode = await child.exited;
if (exitCode !== 0) {
  throw new Error(`VSCE publish failed with exit code ${exitCode}.`);
}
