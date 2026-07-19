import * as assert from "node:assert";
import {
  buildScopedModels,
  completeWithModelRuntime,
  getRuntimeModel,
  selectInitialModel,
  type ModelRuntimeLike,
} from "../pi-model-runtime.js";

suite("Pi model runtime compatibility", () => {
  test("looks up models through ModelRuntime", () => {
    const expected = { provider: "anthropic", id: "claude-sonnet-4-5" };
    const runtime: ModelRuntimeLike = {
      getModel: (provider, id) => provider === expected.provider && id === expected.id ? expected : undefined,
      complete: async () => ({ content: [] }),
    };

    assert.strictEqual(getRuntimeModel(runtime, expected.provider, expected.id), expected);
    assert.strictEqual(getRuntimeModel(runtime, "missing", "model"), undefined);
  });

  test("selects a dynamically registered GUI default after service loading", () => {
    const builtin = { provider: "anthropic", id: "claude-sonnet-4-5" };
    const dynamicDefault = { provider: "athenai", id: "gpt-5.6-sol" };
    const runtime: ModelRuntimeLike = {
      getModel: (provider, id) =>
        provider === dynamicDefault.provider && id === dynamicDefault.id ? dynamicDefault : undefined,
      complete: async () => ({ content: [] }),
    };

    assert.strictEqual(
      selectInitialModel(runtime, [builtin, dynamicDefault], {
        guiDefault: { provider: "athenai", id: "gpt-5.6-sol" },
        piDefault: { provider: "athenai", id: "claude-opus-4-6" },
      }),
      dynamicDefault,
    );
  });

  test("falls back to the Pi default when no GUI default is configured", () => {
    const builtin = { provider: "anthropic", id: "claude-sonnet-4-5" };
    const piDefault = { provider: "athenai", id: "gpt-5.6-sol" };
    const runtime: ModelRuntimeLike = {
      getModel: (provider, id) =>
        provider === piDefault.provider && id === piDefault.id ? piDefault : undefined,
      complete: async () => ({ content: [] }),
    };

    assert.strictEqual(
      selectInitialModel(runtime, [builtin, piDefault], { piDefault }),
      piDefault,
    );
  });

  test("builds scoped models without unresolved entries", () => {
    const available = { provider: "openai", id: "gpt-4o" };
    const runtime: ModelRuntimeLike = {
      getModel: (provider, id) => provider === available.provider && id === available.id ? available : undefined,
      complete: async () => ({ content: [] }),
    };

    assert.deepStrictEqual(
      buildScopedModels(runtime, [available, { provider: "missing", id: "unknown" }]),
      [{ model: available, thinkingLevel: "off" }],
    );
  });

  test("completes requests through ModelRuntime", async () => {
    const model = { provider: "anthropic", id: "claude-sonnet-4-5" };
    const context = { messages: [] };
    const options = { maxTokens: 20 };
    let received: unknown[] | undefined;
    const response = { content: [{ type: "text", text: "summary" }] };
    const runtime: ModelRuntimeLike = {
      getModel: () => model,
      complete: async (...args) => {
        received = args;
        return response;
      },
    };

    assert.strictEqual(await completeWithModelRuntime(runtime, model, context, options), response);
    assert.deepStrictEqual(received, [model, context, options]);
  });
});
