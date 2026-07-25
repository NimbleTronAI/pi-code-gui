import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PiService } from "../pi-service.js";

suite("PiService session persistence", () => {
  let tempDir: string;

  setup(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-on-code-session-"));
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

  test("agent_settled marks the session idle without an unhandled-event diagnostic", () => {
    const events: Array<{ type: string; data?: { customType?: string; isStreaming?: boolean } }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused white-box regression test
    const service = new PiService() as any;
    service._isStreaming = true;
    service.sessionManager = { getEntries: () => [] };
    service.onEvent((event: { type: string; data?: { customType?: string; isStreaming?: boolean } }) => events.push(event));

    service.handleAgentEvent({ type: "agent_settled" });

    assert.strictEqual(service._isStreaming, false);
    assert.ok(events.some((event) => event.type === "status-update" && event.data?.isStreaming === false));
    assert.ok(!events.some((event) => event.type === "custom-message" && event.data?.customType === "pi-on-code-diagnostic"));
  });

  test("extracts image attachments from persisted user message content", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused white-box regression test
    const service = new PiService() as any;
    const images = service.extractImagesFromContent([
      { type: "text", text: "describe this" },
      { type: "image", data: "cG5n", mimeType: "image/png" },
      { type: "toolCall", id: "ignored" },
    ]);

    assert.deepStrictEqual(images, [
      { type: "image", data: "cG5n", mimeType: "image/png" },
    ]);
  });

  test("replaces follow-up order while preserving steering messages", async () => {
    const queued: Array<{ mode: "steer" | "followUp"; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused white-box regression test
    const service = new PiService() as any;
    service.session = {
      clearQueue: () => ({ steering: ["interrupt first"], followUp: ["old one", "old two"] }),
      steer: async (text: string) => { queued.push({ mode: "steer", text }); },
      followUp: async (text: string) => { queued.push({ mode: "followUp", text }); },
    };

    await service.replaceFollowUpQueue(["second", "first"]);

    assert.deepStrictEqual(queued, [
      { mode: "steer", text: "interrupt first" },
      { mode: "followUp", text: "second" },
      { mode: "followUp", text: "first" },
    ]);
  });

  test("promoting a follow-up preserves the other pending messages", async () => {
    const queued: Array<{ mode: "steer" | "followUp"; text: string }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused white-box regression test
    const service = new PiService() as any;
    service.session = {
      clearQueue: () => ({ steering: ["existing steer"], followUp: ["promote me", "keep me"] }),
      steer: async (text: string) => { queued.push({ mode: "steer", text }); },
      followUp: async (text: string) => { queued.push({ mode: "followUp", text }); },
    };

    await service.promoteToSteer("promote me");

    assert.deepStrictEqual(queued, [
      { mode: "steer", text: "existing steer" },
      { mode: "steer", text: "promote me" },
      { mode: "followUp", text: "keep me" },
    ]);
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
      customType: "pi-on-code.active-tools",
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
        customType: "pi-on-code.active-tools",
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
