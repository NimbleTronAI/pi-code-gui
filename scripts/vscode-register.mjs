// Install the `vscode` → stub loader hook for the headless unit tests. Used via
// `node --import ./scripts/vscode-register.mjs --test …` (see the test:unit script).
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./vscode-hooks.mjs", pathToFileURL(new URL(".", import.meta.url).pathname));
