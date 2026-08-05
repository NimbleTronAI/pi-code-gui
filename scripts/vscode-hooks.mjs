// ESM loader `resolve` hook: redirect bare `import "vscode"` to the test stub. Registered by
// scripts/vscode-register.mjs and active only for the headless unit-test run (test:unit).
import { pathToFileURL } from "node:url";
import { resolve as resolvePath } from "node:path";

const STUB_URL = pathToFileURL(resolvePath(process.cwd(), "scripts/vscode-stub.mjs")).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "vscode") {
    return { url: STUB_URL, shortCircuit: true };
  }
  const result = await nextResolve(specifier, context);
  // Registering any loader hook makes Node enforce the `type: "json"` import attribute, which
  // TypeScript's Node16 emit omits (PiService imports model-registry.generated.json). Add it so
  // JSON imports keep working under the test loader.
  if (result.url.endsWith(".json") && result.importAttributes?.type !== "json") {
    return { ...result, importAttributes: { ...result.importAttributes, type: "json" } };
  }
  return result;
}
