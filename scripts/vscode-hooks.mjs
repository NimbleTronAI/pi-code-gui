// ESM loader `resolve` hook: redirect bare `import "vscode"` to the test stub. Registered by
// scripts/vscode-register.mjs and active only for the headless unit-test run (test:unit).
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";

const STUB_URL = pathToFileURL(resolvePath(process.cwd(), "scripts/vscode-stub.mjs")).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier === "vscode") {
    return { url: STUB_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
