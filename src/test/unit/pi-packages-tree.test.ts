// The Packages view (pi-packages-tree-provider.ts), driven headlessly through the vscode stub.
// Pi has one runtime, so the view names none: the Installed header counts what Pi loads, and a
// package Pi filters out says so without naming a runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PiPackagesTreeProvider } from "../../pi-packages-tree-provider.js";
import type { PiPackageService, InstalledPackage } from "../../pi-package-service.js";

type Any = ReturnType<typeof JSON.parse>;

const installed: InstalledPackage[] = [
  { source: "npm:loaded", scope: "user", filtered: false },
  { source: "npm:filtered", scope: "project", filtered: true },
];

function makeTree(): PiPackagesTreeProvider {
  const tree = new PiPackagesTreeProvider({} as PiPackageService);
  (tree as Any).installed = installed;
  (tree as Any).activeSources = new Set(["npm:loaded"]);
  return tree;
}

const RUNTIME_WORDS = /typescript|\bTS\b|runtime/i;

test("the Installed header counts the packages Pi loads, and names no runtime", async () => {
  const [header] = await makeTree().getChildren();
  assert.equal(header.description, "1/2 active");
  const tip = (header.tooltip as Any).value as string;
  assert.doesNotMatch(tip, RUNTIME_WORDS);
  assert.match(tip, /\*\*Active\*\*/, "the tooltip still explains active vs available");
});

test("an installed package Pi does not load says so, without naming a runtime", async () => {
  const tree = makeTree();
  const [header] = await tree.getChildren();
  const items = await tree.getChildren(header);
  const filtered = items.find((i) => i.label === "filtered")!;
  assert.equal(filtered.description, "project  · not loaded");
  assert.equal(items.find((i) => i.label === "loaded")!.description, "user");
});

test("an empty Installed header carries no description", async () => {
  const tree = new PiPackagesTreeProvider({} as PiPackageService);
  const [header] = await tree.getChildren();
  assert.equal(header.description, undefined);
});
