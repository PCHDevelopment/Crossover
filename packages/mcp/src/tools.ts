import type { MethodName } from "@crossover/protocol";
import {
  changesetInputSchema,
  workspaceDiffParamsSchema,
  workspaceListParamsSchema,
  workspaceReadParamsSchema,
  workspaceSearchParamsSchema,
} from "@crossover/workspace";
import { z } from "zod";

/**
 * A tool the MCP server offers: a name an agent sees, the room command it runs, and the
 * arguments it takes. Calls go through the same dispatcher as REST, so the policy, idempotency
 * and events are identical (T707).
 */
export interface McpToolDefinition {
  /** What the agent calls it: `snake_case`, no dots (some MCP clients reject them). */
  name: string;
  description: string;
  /** The command it runs. */
  method: MethodName;
  /** Tool arguments. They become the command's `params` unless `toParams` says otherwise. */
  input: z.ZodRawShape;
  toParams?: (args: Record<string, unknown>) => Record<string, unknown>;
  /** Mutating tools also accept an optional `idempotency_key`, so a retry can be made safe. */
  mutating: boolean;
}

/** The skeleton's tools; the task and collaboration tools (T708, T709) add theirs. */
export const BASE_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "room_get_state",
    description:
      "Get the room's current state: its objective, status, participants and roles. Start here.",
    method: "room.get_state",
    input: {},
    mutating: false,
  },
  {
    name: "capabilities_list",
    description:
      "List what a participant may do: role bundle, granted capabilities and revocations. Defaults to you.",
    method: "capabilities.list",
    input: { participant_id: z.string().optional().describe("Defaults to you") },
    mutating: false,
  },
];

/** Canonical workspace tools (T710); every call is dispatched under the authenticated agent. */
export const WORKSPACE_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a file from the canonical workspace at its current revision.",
    method: "workspace.read",
    input: workspaceReadParamsSchema.shape,
    mutating: false,
  },
  {
    name: "list_dir",
    description: "List readable direct children of a directory in the canonical workspace.",
    method: "workspace.list",
    input: workspaceListParamsSchema.shape,
    mutating: false,
  },
  {
    name: "grep",
    description: "Search readable files in the canonical workspace.",
    method: "workspace.search",
    input: workspaceSearchParamsSchema.shape,
    mutating: false,
  },
  {
    name: "diff",
    description: "Show changes between committed canonical workspace revisions.",
    method: "workspace.diff",
    input: workspaceDiffParamsSchema.shape,
    mutating: false,
  },
  {
    name: "apply_changeset",
    description: "Apply a validated ChangeSet to the canonical workspace.",
    method: "workspace.apply_changeset",
    input: changesetInputSchema.shape,
    mutating: true,
  },
];

export const MCP_TOOLS: readonly McpToolDefinition[] = [...BASE_TOOLS, ...WORKSPACE_TOOLS];
