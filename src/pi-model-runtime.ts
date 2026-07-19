/* eslint-disable @typescript-eslint/no-explicit-any -- Pi SDK is loaded dynamically at runtime. */

export interface ModelRuntimeLike {
  getModel(provider: string, modelId: string): any | undefined;
  complete(model: any, context: any, options?: any): Promise<any>;
}

export interface ModelReference {
  provider: string;
  id: string;
}

export interface InitialModelDefaults {
  guiDefault?: ModelReference;
  piDefault?: ModelReference;
}

/** Resolve a model through the canonical SDK runtime API. */
export function getRuntimeModel(
  runtime: ModelRuntimeLike | null | undefined,
  provider: string,
  modelId: string,
): any | undefined {
  return runtime?.getModel(provider, modelId);
}

/**
 * Select a new session's initial model after SDK services have loaded provider
 * extensions. GUI settings override Pi settings; the first available model is
 * used only when neither configured default resolves.
 */
export function selectInitialModel(
  runtime: ModelRuntimeLike,
  availableModels: any[],
  defaults: InitialModelDefaults,
): any | undefined {
  for (const reference of [defaults.guiDefault, defaults.piDefault]) {
    if (!reference) { continue; }
    const model = getRuntimeModel(runtime, reference.provider, reference.id)
      ?? availableModels.find((candidate) =>
        candidate.provider === reference.provider && candidate.id === reference.id);
    if (model) { return model; }
  }
  return availableModels[0];
}

/** Convert model references into the SDK's scoped-model shape. */
export function buildScopedModels(
  runtime: ModelRuntimeLike,
  models: ModelReference[],
): Array<{ model: any; thinkingLevel: "off" }> {
  return models.flatMap(({ provider, id }) => {
    const model = getRuntimeModel(runtime, provider, id);
    return model ? [{ model, thinkingLevel: "off" as const }] : [];
  });
}

/** Complete a lightweight request through ModelRuntime rather than legacy pi-ai globals. */
export function completeWithModelRuntime(
  runtime: ModelRuntimeLike,
  model: any,
  context: any,
  options?: any,
): Promise<any> {
  return runtime.complete(model, context, options);
}
