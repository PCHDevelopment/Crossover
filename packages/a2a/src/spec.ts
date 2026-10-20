import { z } from "zod";

/** Wire subset pinned to A2A v1.0.0 (§15.5). Unknown peer fields are stripped. */
export const A2A_PROTOCOL_VERSION = "1.0";
export const A2A_SPEC_URL = "https://a2a-protocol.org/v1.0.0/specification/";

export const TASK_STATES = [
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_AUTH_REQUIRED",
] as const;
export const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);

const bounded = z.string().max(1_000);
const identifier = z.string().min(1).max(200);
const metadata = z.record(z.string(), z.unknown());
const partKeys = ["text", "raw", "url", "data"] as const;
const base64 = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

export const partSchema = z
  .object({
    text: z
      .string()
      .max(32 * 1024)
      .optional(),
    raw: base64.refine((value) => Buffer.byteLength(value, "base64") <= 1024 * 1024).optional(),
    url: z.url().optional(),
    data: z.unknown().optional(),
    filename: bounded.optional(),
    mediaType: bounded.optional(),
    metadata: metadata.optional(),
  })
  .refine((value) => partKeys.filter((key) => Object.hasOwn(value, key)).length === 1, {
    message: "exactly one of text, raw, url or data is required",
  });

export const messageSchema = z.object({
  messageId: identifier,
  contextId: identifier.optional(),
  taskId: identifier.optional(),
  role: z.enum(["ROLE_USER", "ROLE_AGENT"]),
  parts: z.array(partSchema).min(1).max(100),
  metadata: metadata.optional(),
  extensions: z.array(z.string().max(1_000)).max(20).optional(),
  referenceTaskIds: z.array(identifier).max(100).optional(),
});

export const artifactSchema = z.object({
  artifactId: identifier,
  name: bounded.optional(),
  description: bounded.optional(),
  parts: z.array(partSchema).min(1).max(100),
  metadata: metadata.optional(),
  extensions: z.array(z.string().max(1_000)).max(20).optional(),
});

export const taskSchema = z.object({
  id: identifier,
  contextId: identifier.optional(),
  status: z.object({
    state: z.enum(TASK_STATES),
    message: messageSchema.optional(),
    timestamp: z.iso.datetime({ offset: true }).optional(),
  }),
  artifacts: z.array(artifactSchema).max(100).optional(),
  history: z.array(messageSchema).max(100).optional(),
  metadata: metadata.optional(),
});

export const sendMessageRequestSchema = z.object({
  message: messageSchema,
  configuration: z
    .object({
      acceptedOutputModes: z.array(bounded).max(100).optional(),
      historyLength: z.number().int().min(0).max(100).optional(),
      returnImmediately: z.boolean().optional(),
    })
    .optional(),
  metadata: metadata.optional(),
});

export const sendMessageResponseSchema = z
  .object({ task: taskSchema.optional(), message: messageSchema.optional() })
  .refine((value) => Number(value.task !== undefined) + Number(value.message !== undefined) === 1);
export const getTaskRequestSchema = z.object({
  id: identifier,
  historyLength: z.number().int().min(0).max(100).optional(),
});
export const cancelTaskRequestSchema = z.object({ id: identifier, metadata: metadata.optional() });
export const listTasksRequestSchema = z.object({
  contextId: identifier.optional(),
  status: z.enum(TASK_STATES).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  pageToken: z.string().max(2_000).optional(),
});

export const agentCardSchema = z.object({
  name: bounded,
  description: bounded,
  version: bounded,
  supportedInterfaces: z
    .array(
      z.object({
        url: z.url(),
        protocolBinding: bounded,
        protocolVersion: bounded,
        tenant: bounded.optional(),
      }),
    )
    .min(1)
    .max(10),
  capabilities: z.object({
    streaming: z.boolean().optional(),
    pushNotifications: z.boolean().optional(),
    extendedAgentCard: z.boolean().optional(),
  }),
  defaultInputModes: z.array(bounded).max(100),
  defaultOutputModes: z.array(bounded).max(100),
  skills: z
    .array(
      z.object({
        id: identifier,
        name: bounded,
        description: bounded,
        tags: z.array(bounded).max(20),
        examples: z.array(bounded).max(20).optional(),
      }),
    )
    .max(50),
  provider: z.object({ organization: bounded, url: z.url() }).optional(),
  securitySchemes: z.record(z.string(), z.unknown()).optional(),
  securityRequirements: z.array(z.record(z.string(), z.array(z.string()))).optional(),
});

export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string().min(1).max(100),
  params: z.unknown().optional(),
});

export const A2A_ERRORS = {
  JSONParse: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  TaskNotFound: -32001,
  TaskNotCancelable: -32002,
  PushNotificationNotSupported: -32003,
  UnsupportedOperation: -32004,
  ContentTypeNotSupported: -32005,
  InvalidAgentResponse: -32006,
  ExtendedAgentCardNotConfigured: -32007,
  ExtensionSupportRequired: -32008,
  VersionNotSupported: -32009,
} as const;

export function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

export type Part = z.infer<typeof partSchema>;
export type Message = z.infer<typeof messageSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type Task = z.infer<typeof taskSchema>;
export type AgentCard = z.infer<typeof agentCardSchema>;
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;
export type SendMessageResponse = z.infer<typeof sendMessageResponseSchema>;
export type GetTaskRequest = z.infer<typeof getTaskRequestSchema>;
export type CancelTaskRequest = z.infer<typeof cancelTaskRequestSchema>;
export type ListTasksRequest = z.infer<typeof listTasksRequestSchema>;
export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;
