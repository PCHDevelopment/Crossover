import type { MethodName } from "@crossover/protocol";
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
