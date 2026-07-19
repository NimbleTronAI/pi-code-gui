import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PiService } from "../pi-service.js";

suite("PiService session persistence", () => {
  let tempDir: string;

  setup(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-code-gui-session-"));
  });

  teardown(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("model and thinking changes do not create a headerless session file", async () => {
    const sessionFile = path.join(tempDir, "new-session.jsonl");
    const model = { provider: "test-provider", id: "test-model" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused white-box regression test
    const service = new PiService() as any;

    service.modelRuntime = {
      getModel: (provider: string, id: string) =>
        provider === model.provider && id === model.id ? model : undefined,
    };
    service.sessionManager = {
      getSessionFile: () => sessionFile,
      getEntries: () => [],
    };
    service.session = {
      setModel: async () => undefined,
      setThinkingLevel: () => undefined,
    };

    await service.setModel(model.provider, model.id);
    await service.setThinkingLevel("high");

    assert.strictEqual(
      fs.existsSync(sessionFile),
      false,
      "PiService must let the SDK SessionManager create and persist the session file",
    );
  });

  test("active tool selection uses a SessionManager custom entry instead of raw file writes", () => {
    const sessionFile = path.join(tempDir, "new-session.jsonl");
    const appended: Array<{ customType: string; data: unknown }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused white-box regression test
    const service = new PiService() as any;

    service.sessionManager = {
      getSessionFile: () => sessionFile,
      appendCustomEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
    };
    service.session = {
      setActiveToolsByName: () => undefined,
      getActiveToolNames: () => ["read", "vscode_get_selection"],
    };

    service.setActiveTools(["read", "vscode_get_selection"]);

    assert.strictEqual(fs.existsSync(sessionFile), false);
    assert.deepStrictEqual(appended, [{
      customType: "pi-code-gui.active-tools",
      data: { toolNames: ["read", "vscode_get_selection"] },
    }]);
  });

  test("active tools restore from custom entries and legacy entries", () => {
    const restored: string[][] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused white-box regression test
    const service = new PiService() as any;
    service.session = { setActiveToolsByName: (names: string[]) => restored.push(names) };

    service.sessionManager = {
      getEntries: () => [{
        type: "custom",
        customType: "pi-code-gui.active-tools",
        data: { toolNames: [] },
      }],
    };
    service._restoreActiveToolsFromSession();

    service.sessionManager = {
      getEntries: () => [{ type: "tools_active_change", toolNames: ["read"] }],
    };
    service._restoreActiveToolsFromSession();

    assert.deepStrictEqual(restored, [[], ["read"]]);
  });
});
