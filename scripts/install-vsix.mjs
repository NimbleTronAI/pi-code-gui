import { resolve } from "node:path";

const manifest = await Bun.file("package.json").json();
const extensionId = `${manifest.publisher}.${manifest.name}`;
const packagePath = resolve("artifacts", `${manifest.name}-${manifest.version}.vsix`);

if (!(await Bun.file(packagePath).exists())) {
  console.error(`VSIX not found: ${packagePath}`);
  console.error("Run `bun run build` first.");
  process.exit(1);
}

const vscodeCli = process.env.VSCODE_CLI?.trim() || "code";
console.log(`Installing ${extensionId}@${manifest.version} from ${packagePath}`);

let child;
try {
  child = Bun.spawn({
    cmd: [vscodeCli, "--install-extension", packagePath, "--force"],
    cwd: process.cwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
} catch (error) {
  console.error(`Unable to start VS Code CLI '${vscodeCli}'.`);
  console.error("Ensure `code` is on PATH or set VSCODE_CLI to its executable path.");
  throw error;
}

const exitCode = await child.exited;
if (exitCode !== 0) {
  process.exit(exitCode);
}

console.log(`Installed ${extensionId}@${manifest.version}. Reload VS Code to activate it.`);
