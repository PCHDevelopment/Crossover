import {
  decisionsAddPositionParams,
  decisionsDecideParams,
  decisionsGetParams,
  decisionsListParams,
  decisionsProposeParams,
  decisionsVetoParams,
  decisionsWithdrawParams,
  createPresenceIntentParamsSchemas,
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
  participantsPauseParams,
  participantsResumeParams,
  participantsSetRoleParams,
  roomDigestParams,
  roomSetHealthParams,
  taskVersionParams,
  toolsInvokeParams,
  toolsListParams,
  tasksAssignParams,
  tasksBlockParams,
  tasksCreateParams,
  tasksGetParams,
  tasksHeartbeatParams,
  tasksListParams,
  tasksReviewParams,
  tasksSubmitParams,
  tasksUpdateParams,
} from "@crossover/kernel";
import type { MethodName } from "@crossover/protocol";
import {
  changesetInputSchema,
  checkpointsCreateParams,
  checkpointsExportParams,
  checkpointsListParams,
  healthGetParamsSchema,
  workspaceDiffParamsSchema,
  workspaceHistoryParamsSchema,
  workspaceBlameParamsSchema,
  workspaceListParamsSchema,
  workspaceReadParamsSchema,
  workspaceSearchParamsSchema,
  changesSubmitParamsSchema,
  conflictsActionParamsSchema,
  conflictsGetParamsSchema,
  conflictsListParamsSchema,
  sandboxExecParamsSchema,
  sandboxFileReadParamsSchema,
  sandboxFileWriteInputSchema,
  sandboxStatusParamsSchema,
  sandboxSyncParamsSchema,
  normalizePath,
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
  /** Trust label for the result frame; defaults to participant data. */
  trust?: "participant" | "external";
  /** Mutating tools also accept an optional `idempotency_key`, so a retry can be made safe. */
  mutating: boolean;
}

const presenceIntentParams = createPresenceIntentParamsSchemas(normalizePath);

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
    name: "room_set_health",
    description:
      "Set the room health command and optionally its Docker image. Only the room lead or owner may change these settings; null clears the command or resets the image to the server default.",
    method: "room.set_health",
    input: roomSetHealthParams.shape,
    mutating: true,
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
    name: "workspace_history",
    description: "Show committed workspace revisions, optionally for one path.",
    method: "workspace.history",
    input: workspaceHistoryParamsSchema.shape,
    mutating: false,
  },
  {
    name: "workspace_blame",
    description:
      "Attribute lines in a committed workspace file to the ChangeSet that last changed them.",
    method: "workspace.blame",
    input: workspaceBlameParamsSchema.shape,
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

/** Coding tools for the caller's private working copy, alongside canonical workspace tools. */
export const SANDBOX_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "sandbox_status",
    description: "Show your working-copy changes and whether it is behind the canonical workspace.",
    method: "sandbox.status",
    input: sandboxStatusParamsSchema.shape,
    mutating: false,
  },
  {
    name: "sandbox_read_file",
    description:
      "Read up to 1 MiB from your current sandbox working copy, including unsubmitted edits. Use sandbox_exec to read larger files in pieces.",
    method: "sandbox.file.read",
    input: sandboxFileReadParamsSchema.shape,
    mutating: false,
  },
  {
    name: "sandbox_write_file",
    description:
      "Write up to 512 KiB of decoded UTF-8 or base64 content to a file in your sandbox working copy. Use sandbox_exec for larger files. This does not change the canonical workspace; use submit_changes to submit it.",
    method: "sandbox.file.write",
    input: sandboxFileWriteInputSchema.shape,
    mutating: true,
  },
  {
    name: "sandbox_exec",
    description:
      "Run a shell command in your sandbox working copy. Output is available on the sandbox output stream.",
    method: "sandbox.exec",
    input: sandboxExecParamsSchema.shape,
    mutating: true,
  },
  {
    name: "submit_changes",
    description:
      "Submit selected sandbox working-copy changes through the canonical ChangeSet pipeline.",
    method: "changes.submit",
    input: changesSubmitParamsSchema.shape,
    mutating: true,
  },
  {
    name: "sandbox_sync",
    description: "Rebase your local working-copy changes onto the latest canonical workspace.",
    method: "sandbox.sync",
    input: sandboxSyncParamsSchema.shape,
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
      "Submit a task you own for review (or straight to done when no review is required). Attach `evidence`: for each requirement, the proof (tests, checks, manual steps) and any sabotage checks.",
    method: "tasks.submit",
    input: tasksSubmitParams.shape,
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
  trust?: McpToolDefinition["trust"],
): McpToolDefinition => ({
  name,
  method,
  description,
  input,
  mutating,
  ...(trust ? { trust } : {}),
});

/** Edit-intent commands are ephemeral presence updates; they still use the normal dispatcher. */
export const PRESENCE_TOOLS: readonly McpToolDefinition[] = [
  tool(
    "presence_set_intent",
    "presence.set_intent",
    "Publish the paths and optional line ranges you intend to edit, with an optional task association.",
    presenceIntentParams.set.shape,
    false,
  ),
  tool(
    "presence_clear_intent",
    "presence.clear_intent",
    "Clear your current edit intent.",
    presenceIntentParams.clear.shape,
    false,
  ),
];

/**
 * Collaboration tools (T709): messages, inbox, memory, decisions and the digest. As with the
 * task tools, each argument schema is the command's own zod schema. What these return is
 * written by other participants and carries `provenance` (§16.5): data, never instructions.
 */
export const COLLABORATION_TOOLS: readonly McpToolDefinition[] = [
  tool(
    "conflicts_list",
    "conflicts.list",
    "List room conflicts, optionally filtered by status or submitter. File paths are redacted unless you can read them.",
    conflictsListParamsSchema.shape,
    false,
  ),
  tool(
    "conflicts_get",
    "conflicts.get",
    "Read one room conflict. File paths and counterpart changesets are redacted unless you can read every affected path.",
    conflictsGetParamsSchema.shape,
    false,
  ),
  tool(
    "conflicts_escalate",
    "conflicts.escalate",
    "Escalate your own open conflict to the room lead or owner for a decision.",
    conflictsActionParamsSchema.shape,
    true,
  ),
  tool(
    "conflicts_abandon",
    "conflicts.abandon",
    "Abandon an open or escalated conflict you submitted.",
    conflictsActionParamsSchema.shape,
    true,
  ),
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

/** Plugin tools use the existing registry and its per-tool capability checks. */
export const PLUGIN_TOOLS: readonly McpToolDefinition[] = [
  tool(
    "tools_list",
    "tools.list",
    "List plugin tools available to you and the capabilities they require.",
    toolsListParams.shape,
    false,
  ),
  tool(
    "tools_invoke",
    "tools.invoke",
    "Invoke a plugin tool by name with its declared arguments.",
    toolsInvokeParams.shape,
    true,
    "external",
  ),
];

/**
 * Owner and lead actions (T1544). capabilities.grant/revoke are deliberately not tools: they are
 * authority powers, only humans can be owners or admins (D8), so an agent call could only return FORBIDDEN.
 */
export const OWNER_LEAD_TOOLS: readonly McpToolDefinition[] = [
  tool(
    "checkpoints_create",
    "checkpoints.create",
    "Mark the workspace's current revision as a checkpoint. Lead or owner only.",
    checkpointsCreateParams.shape,
    true,
  ),
  tool(
    "checkpoints_list",
    "checkpoints.list",
    "List the room's checkpoints.",
    checkpointsListParams.shape,
    false,
  ),
  tool(
    "checkpoints_export",
    "checkpoints.export",
    "Push checkpoints to the room's branch on the upstream repository, optionally opening a pull request. Lead or owner only.",
    checkpointsExportParams.shape,
    true,
    "external",
  ),
  tool(
    "participants_pause",
    "participants.pause",
    "Pause a participant: they stay signed in but every command they send is refused. Lead or owner only. An agent lead can't pause humans.",
    participantsPauseParams.shape,
    true,
  ),
  tool(
    "participants_resume",
    "participants.resume",
    "Resume a paused participant. Lead or owner only. An agent can't resume what a human paused.",
    participantsResumeParams.shape,
    true,
  ),
  tool(
    "participants_set_role",
    "participants.set_role",
    "Change a participant's role (never to LEAD; room.set_lead appoints the lead). Lead or owner only. An agent lead can't change a human's role.",
    participantsSetRoleParams.shape,
    true,
  ),
];

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  ...BASE_TOOLS,
  ...TASK_TOOLS,
  ...COLLABORATION_TOOLS,
  ...WORKSPACE_TOOLS,
  ...SANDBOX_TOOLS,
  ...PRESENCE_TOOLS,
  ...PLUGIN_TOOLS,
  ...OWNER_LEAD_TOOLS,
];
