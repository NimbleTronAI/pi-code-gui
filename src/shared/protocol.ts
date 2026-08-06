// ═══════════════════════════════════════════════════════════════════
// Shared message protocol between extension host and webview
// ═══════════════════════════════════════════════════════════════════
//
// This file is the single source of truth for every message that
// crosses the postMessage bridge. Both src/pi-service.ts (extension)
// and src/webview-panel.ts (webview loader) import from here.
//
// All messages are validated at runtime via Zod schemas.
// TypeScript types are derived from schemas with z.output<typeof S>.
//
// When a message shape changes, update the schema — tsc and runtime
// validation catch mismatches on BOTH sides.

import { z } from "zod";

// ═══ Shared data schemas ════════════════════════════════════

const ImageContentSchema = z.object({
  type: z.literal("image"),
  data: z.string().min(1),
  mimeType: z.string().startsWith("image/"),
});

const TextContentItemSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

const EditorContextItemSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  name: z.string().min(1),
  languageId: z.string(),
  active: z.boolean(),
  dirty: z.boolean(),
  selectionLines: z.number().int().positive().optional(),
  attached: z.boolean().optional(),
  kind: z.enum(["file", "folder"]).optional(),
  external: z.boolean().optional(),
});

const WorkspaceFileItemSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(["file", "folder"]).optional(),
  external: z.boolean().optional(),
  source: z.enum(["workspace", "session"]).optional(),
});

// Pi tool results and custom messages use the same multimodal content model:
// each item is either text or a base64 image.
const ContentArraySchema = z.array(
  z.union([TextContentItemSchema, ImageContentSchema]),
);

// ═══ Extension → Webview schemas ═══════════════════════════

const ExtensionToWebviewSchema = z.discriminatedUnion("type", [
  // Agent lifecycle
  z.object({ type: z.literal("agent-start"), data: z.undefined().optional() }),
  z.object({
    type: z.literal("agent-end"),
    data: z
      .object({ messages: z.array(z.unknown()).optional() })
      .optional(),
  }),

  // Turn lifecycle
  z.object({ type: z.literal("turn-start"), data: z.unknown().optional() }),
  z.object({
    type: z.literal("turn-end"),
    data: z
      .object({
        message: z
          .object({
            role: z.string().optional(),
            content: z.union([z.string(), z.array(z.unknown())]).optional(),
            errorMessage: z.string().optional(),
          })
          .optional(),
        toolResults: z.array(z.unknown()).optional(),
      })
      .optional(),
  }),

  // Message lifecycle
  z.object({
    type: z.literal("chat-message"),
    data: z.object({
      role: z.enum(["user", "assistant"]),
      content: z.string(),
      images: z.array(ImageContentSchema).optional(),
      editorContext: z.array(EditorContextItemSchema).optional(),
      entryId: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("assistant-start"),
    data: z.object({
      messageId: z.string().optional(),
      entryId: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("assistant-end"),
    data: z
      .object({
        stopReason: z.string().optional(),
        errorMessage: z.string().optional(),
        toolCalls: z.array(z.string()).optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("stream-delta"),
    data: z.object({ delta: z.string() }),
  }),
  z.object({
    type: z.literal("thinking-delta"),
    data: z.object({
      delta: z.string(),
      done: z.boolean().optional(),
    }),
  }),

  // Tool lifecycle
  z.object({
    type: z.literal("tool-start"),
    data: z.object({
      toolName: z.string(),
      toolCallId: z.string(),
      args: z.record(z.string(), z.unknown()),
      entryId: z.string().optional(),
      fromMessage: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal("tool-update"),
    data: z.object({
      toolCallId: z.string(),
      toolName: z.string().optional(),
      partialResult: z.object({
        content: ContentArraySchema.optional(),
      }),
    }),
  }),
  z.object({
    type: z.literal("tool-end"),
    data: z.object({
      toolCallId: z.string(),
      toolName: z.string(),
      result: z
        .object({
          content: ContentArraySchema.optional(),
          details: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
      isError: z.boolean(),
      entryId: z.string().optional(),
    }),
  }),

  // Bash execution
  z.object({
    type: z.literal("bash-start"),
    data: z.object({
      toolCallId: z.string(),
      command: z.string(),
      entryId: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("bash-output"),
    data: z.object({
      toolCallId: z.string(),
      output: z.string(),
    }),
  }),
  z.object({
    type: z.literal("bash-end"),
    data: z.object({
      toolCallId: z.string(),
      command: z.string(),
      exitCode: z.number(),
      cancelled: z.boolean(),
      output: z.string(),
      isError: z.boolean(),
      entryId: z.string().optional(),
    }),
  }),

  // Status & Settings
  z.object({
    type: z.literal("status-update"),
    data: z
      .object({
        model: z.string().optional(),
        thinkingLevel: z.string().optional(),
        effort: z.string().optional(),
        usage: z
          .object({
            input: z.number(),
            output: z.number(),
            cost: z.number(),
            contextPercent: z.number().nullable(),
          })
          .optional(),
        isStreaming: z.boolean().optional(),
        ready: z.boolean().optional(),
        reset: z.boolean().optional(),
        sessionId: z.string().optional(),
        contextBudget: z.number().optional(),
      }),
  }),
  z.object({
    type: z.literal("status"),
    data: z
      .object({
        model: z.string().optional(),
        thinkingLevel: z.string().optional(),
        effort: z.string().optional(),
        ready: z.boolean().optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("queue-update"),
    data: z.object({
      steering: z.array(z.string()),
      followUp: z.array(z.string()),
    }),
  }),
  z.object({
    type: z.literal("editor-context-update"),
    data: z.object({
      items: z.array(EditorContextItemSchema),
    }),
  }),
  z.object({
    type: z.literal("workspace-files-update"),
    data: z.object({
      query: z.string(),
      items: z.array(WorkspaceFileItemSchema).max(50),
    }),
  }),
  z.object({
    type: z.literal("attach-workspace-file"),
    data: WorkspaceFileItemSchema,
  }),

  // Compaction & Retry
  z.object({
    type: z.literal("compaction-start"),
    data: z.object({ reason: z.string().optional() }).optional(),
  }),
  z.object({
    type: z.literal("compaction-end"),
    data: z
      .object({
        reason: z.string().optional(),
        aborted: z.boolean().optional(),
        willRetry: z.boolean().optional(),
        result: z.unknown().optional(),
        errorMessage: z.string().optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("compaction-summary-message"),
    data: z.object({
      summary: z.string(),
      tokensBefore: z.number(),
      timestamp: z.number().optional(),
      entryId: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("auto-retry-start"),
    data: z.object({
      attempt: z.number(),
      maxAttempts: z.number(),
      delayMs: z.number(),
      errorMessage: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("auto-retry-end"),
    data: z.object({
      success: z.boolean(),
      attempt: z.number(),
      finalError: z.string().optional(),
    }),
  }),

  // Batch replay
  z.object({
    type: z.literal("batch-start"),
    data: z.object({ hasEntries: z.boolean().optional() }).optional(),
  }),
  z.object({
    type: z.literal("batch-end"),
    data: z.object({
      hasEntries: z.boolean().optional(),
      hasMoreHistory: z.boolean().optional(),
    }).optional(),
  }),
  z.object({
    type: z.literal("history-page"),
    data: z.object({
      hasMoreHistory: z.boolean(),
      events: z.array(z.unknown()),
    }),
  }),
  z.object({
    type: z.literal("conversation-turns-update"),
    data: z.object({
      turns: z.array(z.object({
        entryId: z.string().min(1),
        user: z.string(),
        agent: z.string(),
      })),
    }),
  }),

  // Thinking
  z.object({
    type: z.literal("thinking-level-changed"),
    data: z.object({ level: z.string() }),
  }),

  // Custom messages (extensions)
  z.object({
    type: z.literal("custom-message"),
    data: z.object({
      customType: z.string(),
      content: z.union([z.string(), ContentArraySchema]),
      timestamp: z.number().optional(),
      entryId: z.string().optional(),
      display: z.boolean().optional(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  }),

  // User messages list
  z.object({
    type: z.literal("user-messages-list"),
    data: z.object({
      messages: z.array(
        z.object({ id: z.string().optional(), text: z.string(), timestamp: z.number().optional() }),
      ),
    }),
  }),

  // Scoped models
  z.object({
    type: z.literal("scoped-models-update"),
    data: z.object({
      models: z.array(z.object({ provider: z.string(), id: z.string(), thinkingLevel: z.string() })),
    }),
  }),

  // Settings
  z.object({
    type: z.literal("settings-update"),
    data: z.object({
      autoCompaction: z.boolean(),
      autoRetry: z.boolean(),
      showImages: z.boolean(),
      autoCollapseToolResults: z.boolean(),
      autoAttachActiveEditor: z.boolean(),
    }),
  }),

  // Scroll to entry
  z.object({ type: z.literal("revealEntry"), entryId: z.string(), toolCallId: z.string().optional() }),

  // Error
  z.object({
    type: z.literal("error"),
    data: z.object({ message: z.string() }),
  }),

  // Extension host commands
  z.object({ type: z.literal("sessionReset") }),
  z.object({ type: z.literal("insertCommand"), command: z.string() }),
  z.object({ type: z.literal("viewport-refresh") }),

  // Capabilities active in the current Pi session
  z.object({
    type: z.literal("capabilities-update"),
    data: z.object({
      extensions: z.array(z.object({ name: z.string(), path: z.string() })),
      skills: z.array(z.object({
        name: z.string(),
        description: z.string(),
        path: z.string(),
        scope: z.enum(["user", "project", "temporary"]).optional(),
      })),
    }),
  }),
  z.object({
    type: z.literal("capabilities-panel-update"),
    data: z.object({
      capabilities: z.array(z.object({
        kind: z.enum(["extension", "skill"]),
        name: z.string(),
        description: z.string().optional(),
        path: z.string(),
        enabled: z.boolean(),
        source: z.string(),
        scope: z.enum(["user", "project", "temporary"]),
        origin: z.enum(["package", "top-level"]),
      })),
      loading: z.boolean().optional(),
      error: z.string().optional(),
    }),
  }),

  // Slash commands from builtins, extensions, prompt templates, and skills
  z.object({
    type: z.literal("slash-commands-update"),
    data: z.object({
      commands: z.array(z.object({
        cmd: z.string(),
        desc: z.string(),
        source: z.enum(["builtin", "extension", "prompt", "skill"]).optional(),
        scope: z.enum(["user", "project", "temporary"]).optional(),
      })),
    }),
  }),

  // Extension widget bridge
  z.object({
    type: z.literal("widget-update"),
    data: z.object({
      key: z.string(),
      content: z.string().nullable(),
    }),
  }),

  // Message renderer registration (extension → webview)
  z.object({
    type: z.literal("registerMessageRenderer"),
    data: z.object({
      customType: z.string(),
      sourceCode: z.string(),
    }),
  }),

  // Interactive dialog (extension → webview)
  z.object({
    type: z.literal("show_dialog"),
    data: z.object({
      dialogType: z.enum(["select", "confirm", "input"]),
      id: z.string(),
      prompt: z.string(),
      options: z.array(z.string()).optional(),
      defaultValue: z.string().optional(),
    }),
  }),

  // Focused custom TUI component rendered remotely by the Webview.
  z.object({
    type: z.enum(["custom-ui-open", "custom-ui-update"]),
    data: z.object({
      id: z.string().min(1),
      lines: z.array(z.string()).max(300),
      columns: z.number().int().min(20).max(240),
      overlay: z.boolean().optional(),
      anchor: z.enum([
        "center", "top-left", "top-right", "bottom-left", "bottom-right",
        "top-center", "bottom-center", "left-center", "right-center",
      ]).optional(),
      maxHeight: z.union([
        z.number().positive().max(300),
        z.string().regex(/^\d+(?:\.\d+)?%$/),
      ]).optional(),
    }),
  }),
  z.object({
    type: z.literal("custom-ui-close"),
    data: z.object({ id: z.string().min(1) }),
  }),
]);

// ═══ Webview → Extension schemas ═══════════════════════════

const WebviewToExtensionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("webviewReady") }),
  z.object({
    type: z.literal("prompt"),
    text: z.string(),
    images: z.array(ImageContentSchema).optional(),
    mode: z.enum(["steer", "queue"]).optional(),
    editorContext: z.object({
      includedEditorIds: z.array(z.string().min(1)).max(100),
      attachedFileIds: z.array(z.string().min(1)).max(20).optional(),
    }).optional(),
  }),
  z.object({ type: z.literal("requestEditorContext") }),
  z.object({
    type: z.literal("requestWorkspaceFiles"),
    query: z.string().max(200),
  }),
  z.object({
    type: z.literal("browseContextAttachments"),
    kind: z.enum(["file", "folder"]),
  }),
  z.object({ type: z.literal("abort") }),
  z.object({ type: z.literal("loadOlderHistory") }),
  z.object({ type: z.literal("loadHistoryToEntry"), entryId: z.string().min(1) }),
  z.object({ type: z.literal("slashCommand"), command: z.string() }),
  z.object({ type: z.literal("pickModel") }),
  z.object({ type: z.literal("pickThinkingLevel") }),
  z.object({ type: z.literal("pickEffort") }),
  z.object({ type: z.literal("pickContextBudget") }),
  z.object({ type: z.literal("getCapabilities") }),
  z.object({ type: z.literal("reloadCapabilities") }),
  z.object({
    type: z.literal("setCapabilityEnabled"),
    kind: z.enum(["extension", "skill"]),
    path: z.string().min(1),
    enabled: z.boolean(),
  }),
  z.object({ type: z.literal("getSettings") }),
  z.object({ type: z.literal("toggleAutoCompaction") }),
  z.object({ type: z.literal("toggleAutoRetry") }),
  z.object({ type: z.literal("toggleShowImages") }),
  z.object({ type: z.literal("toggleAutoCollapseToolResults") }),
  z.object({ type: z.literal("toggleAutoAttachActiveEditor") }),
  z.object({ type: z.literal("openUrl"), url: z.string() }),
  z.object({ type: z.literal("openFile"), path: z.string() }),
  z.object({ type: z.literal("promoteToSteer"), text: z.string() }),
  z.object({
    type: z.literal("replaceFollowUpQueue"),
    messages: z.array(z.string().min(1)).max(100),
  }),
  z.object({ type: z.literal("clearQueue") }),
  z.object({ type: z.literal("resendUserMessage"), text: z.string() }),
  z.object({ type: z.literal("extension_ui_response"), id: z.string(), value: z.unknown() }),
  z.object({
    type: z.literal("custom_ui_input"),
    id: z.string().min(1),
    input: z.string().min(1).max(32),
    columns: z.number().int().min(20).max(240).optional(),
  }),
  z.object({
    type: z.literal("custom_ui_resize"),
    id: z.string().min(1),
    columns: z.number().int().min(20).max(240),
  }),
]);

// ═══ Derived TypeScript types ═════════════════════════════

/** Metadata shown for one visible VS Code editor attached to a prompt. */
export type EditorContextItem = z.output<typeof EditorContextItemSchema>;

/** Workspace file offered by @ autocomplete. */
export type WorkspaceFileItem = z.output<typeof WorkspaceFileItemSchema>;

/** All message types sent from extension host to webview. */
export type ExtensionToWebview = z.output<typeof ExtensionToWebviewSchema>;

/** All message types sent from webview to extension host. */
export type WebviewToExtension = z.output<typeof WebviewToExtensionSchema>;

/** PiServiceEvent — alias for ExtensionToWebview (all events flowing through emit()). */
export type PiServiceEvent = ExtensionToWebview;

// ═══ Validation utilities ═════════════════════════════════

export interface ValidationResult<T> {
  success: true;
  data: T;
  error?: undefined;
}

export interface ValidationError {
  success: false;
  data?: undefined;
  error: string;
}

/**
 * Validate an incoming extension→webview message.
 * Returns the parsed message or an error string.
 * Unknown fields are stripped (zod strips by default in v4).
 */
export function validateExtensionToWebview(
  msg: unknown,
): ValidationResult<ExtensionToWebview> | ValidationError {
  const result = ExtensionToWebviewSchema.safeParse(msg);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error.message };
}

/**
 * Validate an outgoing webview→extension message.
 */
export function validateWebviewToExtension(
  msg: unknown,
): ValidationResult<WebviewToExtension> | ValidationError {
  const result = WebviewToExtensionSchema.safeParse(msg);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error.message };
}

/**
 * Schema-only validation (for emit() — logs + notifies but does not
 * block the event from dispatching to maintain backward compat).
 */
export function isExtensionToWebview(msg: unknown): msg is ExtensionToWebview {
  return ExtensionToWebviewSchema.safeParse(msg).success;
}
