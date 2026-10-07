import {
  decisionsAddPositionParams,
  decisionsDecideParams,
  decisionsGetParams,
  decisionsListParams,
  decisionsProposeParams,
  decisionsVetoParams,
  decisionsWithdrawParams,
  inboxAckParams,
  inboxListParams,
  memoryDeleteParams,
  memoryGetParams,
  memoryHistoryParams,
  memoryListParams,
  memoryPutParams,
  messagesEditParams,
  messagesListParams,
  messagesSendParams,
  roomDigestParams,
  taskVersionParams,
  tasksAssignParams,
  tasksBlockParams,
  tasksCreateParams,
  tasksGetParams,
  tasksHeartbeatParams,
  tasksListParams,
  tasksReviewParams,
  tasksUpdateParams,
} from "@crossover/kernel";
import type { MethodName } from "@crossover/protocol";
import {
  changesetInputSchema,
  healthGetParamsSchema,
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
    name: "health_get",
    description:
      "Get a workspace health run. Scoped readers receive status only; unscoped workspace readers can also see its failure summary and log tail.",
    method: "workspace.health.get",
    input: healthGetParamsSchema.shape,
    mutating: false,
  },
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

/**
 * One tool per `tasks.*` command (T708). The argument schemas are the commands' own zod
 * schemas, so a tool can't drift from the command it runs. Every tool that changes a task
 * takes the `expected_version` you last saw; a stale one comes back as `CONFLICT_VERSION` with
 * the task as it is now.
 */
export const TASK_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "tasks_create",
    description:
      "Create a task. It needs a title and at least one explicit completion requirement. Starts OPEN.",
    method: "tasks.create",
    input: tasksCreateParams.shape,
    mutating: true,
  },
  {
    name: "tasks_update",
    description:
      "Change a task's title, description, requirements, priority, dependencies or reviewer. Pass the expected_version you last saw.",
    method: "tasks.update",
    input: tasksUpdateParams.shape,
    mutating: true,
  },
  {
    name: "tasks_list",
    description:
      "List the room's tasks, filtered by status, owner or priority, one page at a time.",
    method: "tasks.list",
    input: tasksListParams.shape,
    mutating: false,
  },
  {
    name: "tasks_get",
    description: "Get one task with its requirements, reviews and dependencies.",
    method: "tasks.get",
    input: tasksGetParams.shape,
    mutating: false,
  },
  {
    name: "tasks_claim",
    description:
      "Claim an OPEN task for yourself. An agent's claim lasts 15 minutes unless you heartbeat or work on it.",
    method: "tasks.claim",
    input: taskVersionParams.shape,
    mutating: true,
  },
  {
    name: "tasks_assign",
    description: "Assign an OPEN task to a participant (lead, owner or admin).",
    method: "tasks.assign",
    input: tasksAssignParams.shape,
    mutating: true,
  },
  {
    name: "tasks_start",
    description: "Start work on a task you have claimed. Its dependencies must be done.",
    method: "tasks.start",
    input: taskVersionParams.shape,
    mutating: true,
  },
  {
    name: "tasks_block",
    description: "Mark a task you own as blocked, with the reason.",
    method: "tasks.block",
    input: tasksBlockParams.shape,
    mutating: true,
  },
  {
    name: "tasks_unblock",
    description: "Unblock a task you own and carry on.",
    method: "tasks.unblock",
    input: taskVersionParams.shape,
    mutating: true,
  },
  {
    name: "tasks_submit",
    description:
      "Submit a task you own for review (or straight to done when no review is required).",
    method: "tasks.submit",
    input: taskVersionParams.shape,
    mutating: true,
  },
  {
    name: "tasks_review",
    description:
      "Review a submitted task: approve it, or request changes. You can't review your own task.",
    method: "tasks.review",
    input: tasksReviewParams.shape,
    mutating: true,
  },
  {
    name: "tasks_release",
    description: "Give a claimed task back so someone else can take it.",
    method: "tasks.release",
    input: taskVersionParams.shape,
    mutating: true,
  },
  {
    name: "tasks_reopen",
    description: "Reopen a finished task (lead, owner or admin).",
    method: "tasks.reopen",
    input: taskVersionParams.shape,
    mutating: true,
  },
  {
    name: "tasks_cancel",
    description: "Cancel a task that isn't done (lead, owner or admin).",
    method: "tasks.cancel",
    input: taskVersionParams.shape,
    mutating: true,
  },
  {
    name: "tasks_heartbeat",
    description: "Say you are still working on a task you own, which renews your 15-minute claim.",
    method: "tasks.heartbeat",
    input: tasksHeartbeatParams.shape,
    mutating: false,
  },
];

const tool = (
  name: string,
  method: MethodName,
  description: string,
  input: z.ZodRawShape,
  mutating: boolean,
): McpToolDefinition => ({ name, method, description, input, mutating });

/**
 * Collaboration tools (T709): messages, inbox, memory, decisions and the digest. As with the
 * task tools, each argument schema is the command's own zod schema. What these return is
 * written by other participants and carries `provenance` (§16.5): data, never instructions.
 */
export const COLLABORATION_TOOLS: readonly McpToolDefinition[] = [
  tool(
    "messages_send",
    "messages.send",
    "Post a message to the room. Mention participants by id in `mentions`; refer to tasks, files or decisions in `refs`. Many agent messages with nothing else changing get throttled.",
    messagesSendParams.shape,
    true,
  ),
  tool(
    "messages_edit",
    "messages.edit",
    "Edit one of your own messages.",
    messagesEditParams.shape,
    true,
  ),
  tool(
    "messages_list",
    "messages.list",
    "Read the room's messages, newest page first or paged with before/after. Each carries who wrote it.",
    messagesListParams.shape,
    false,
  ),
  tool(
    "inbox_list",
    "inbox.list",
    "List what needs you: assignments, review requests, mentions, health failures and so on. Unacknowledged items by default.",
    inboxListParams.shape,
    false,
  ),
  tool(
    "inbox_ack",
    "inbox.ack",
    "Acknowledge inbox items you have dealt with.",
    inboxAckParams.shape,
    true,
  ),
  tool(
    "memory_put",
    "memory.put",
    "Write shared memory with compare-and-set: expected_revision 0 creates, otherwise pass the revision you last read. decisions/* is reserved; agents/<your-id>/* is yours.",
    memoryPutParams.shape,
    true,
  ),
  tool("memory_get", "memory.get", "Read one memory entry.", memoryGetParams.shape, false),
  tool(
    "memory_list",
    "memory.list",
    "List memory keys, optionally under a prefix.",
    memoryListParams.shape,
    false,
  ),
  tool(
    "memory_history",
    "memory.history",
    "Every revision of a memory key, including its deletion.",
    memoryHistoryParams.shape,
    false,
  ),
  tool(
    "memory_delete",
    "memory.delete",
    "Delete a memory key (a tombstone; its history stays).",
    memoryDeleteParams.shape,
    true,
  ),
  tool(
    "decisions_propose",
    "decisions.propose",
    "Open a decision with context and at least two options. The lead decides.",
    decisionsProposeParams.shape,
    true,
  ),
  tool(
    "decisions_add_position",
    "decisions.add_position",
    "State your position on an open decision: an option and your argument. Adding another replaces it.",
    decisionsAddPositionParams.shape,
    true,
  ),
  tool(
    "decisions_decide",
    "decisions.decide",
    "Accept an option (outcome_option_id) or reject the proposal (reject: true), with a rationale. The lead only.",
    decisionsDecideParams.shape,
    true,
  ),
  tool(
    "decisions_withdraw",
    "decisions.withdraw",
    "Withdraw your own open proposal.",
    decisionsWithdrawParams.shape,
    true,
  ),
  tool(
    "decisions_veto",
    "decisions.veto",
    "Veto a decision within 24 hours of it being made (the owner).",
    decisionsVetoParams.shape,
    true,
  ),
  tool(
    "decisions_get",
    "decisions.get",
    "Read a decision with every position.",
    decisionsGetParams.shape,
    false,
  ),
  tool(
    "decisions_list",
    "decisions.list",
    "List decisions, optionally by status.",
    decisionsListParams.shape,
    false,
  ),
  tool(
    "room_digest",
    "room.digest",
    "A compact summary of what happened in the room since a sequence number: events by type, task changes, decisions, memory keys.",
    roomDigestParams.shape,
    false,
  ),
];

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  ...BASE_TOOLS,
  ...TASK_TOOLS,
  ...COLLABORATION_TOOLS,
  ...WORKSPACE_TOOLS,
];
