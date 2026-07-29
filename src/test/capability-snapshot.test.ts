import * as assert from "node:assert";
import {
  filterSessionCapabilitySnapshot,
  SessionCapabilitySnapshot,
} from "../capability-snapshot.js";

interface Capability {
  kind: "extension" | "skill";
  path: string;
  enabled: boolean;
  name: string;
}

suite("Session capability snapshots", () => {
  test("reads the captured list without rescanning", async () => {
    let scans = 0;
    const snapshot = new SessionCapabilitySnapshot(async () => {
      scans += 1;
      return [{ name: `scan-${scans}` }];
    });

    assert.deepStrictEqual(snapshot.read(), []);
    assert.deepStrictEqual(snapshot.read(), []);
    assert.strictEqual(scans, 0);

    await snapshot.refresh();
    assert.deepStrictEqual(snapshot.read(), [{ name: "scan-1" }]);
    assert.deepStrictEqual(snapshot.read(), [{ name: "scan-1" }]);
    assert.strictEqual(scans, 1);
  });

  test("excludes newly discovered enabled resources that are not loaded", () => {
    const capabilities: Capability[] = [
      { kind: "skill", path: "/skills/loaded/SKILL.md", enabled: true, name: "loaded" },
      { kind: "skill", path: "/skills/new/SKILL.md", enabled: true, name: "new" },
    ];

    const snapshot = filterSessionCapabilitySnapshot(capabilities, {
      extensions: [],
      skills: ["/skills/loaded/SKILL.md"],
    });

    assert.deepStrictEqual(snapshot.map((item) => item.name), ["loaded"]);
  });

  test("retains disabled resources so they can be enabled again", () => {
    const capabilities: Capability[] = [
      { kind: "skill", path: "/skills/disabled/SKILL.md", enabled: false, name: "disabled" },
    ];

    const snapshot = filterSessionCapabilitySnapshot(capabilities, {
      extensions: [],
      skills: [],
    });

    assert.deepStrictEqual(snapshot.map((item) => item.name), ["disabled"]);
  });

  test("matches loaded paths within the correct capability kind", () => {
    const sharedPath = "/resources/shared.ts";
    const capabilities: Capability[] = [
      { kind: "extension", path: sharedPath, enabled: true, name: "extension" },
      { kind: "skill", path: sharedPath, enabled: true, name: "skill" },
    ];

    const snapshot = filterSessionCapabilitySnapshot(capabilities, {
      extensions: [sharedPath],
      skills: [],
    });

    assert.deepStrictEqual(snapshot.map((item) => item.name), ["extension"]);
  });
});
