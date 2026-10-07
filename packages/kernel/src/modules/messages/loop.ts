import type { PoolClient } from "@crossover/db";
import { CrossoverError } from "@crossover/protocol";
import type { EmittedEvent } from "../../dispatcher.js";
import { deliverInbox } from "../inbox/inbox.js";

/** More than this many consecutive agent messages with no state change is a loop (§17.6). */
export const LOOP_MESSAGE_LIMIT = 20;
/** Once a loop is detected, each of its agents may send one message per this many seconds. */
export const LOOP_THROTTLE_SECONDS = 60;

/** Events that are a state change in the sense of §17.6: tasks, ChangeSets, decisions, memory. */
const isStateChange = (type: string): boolean =>
  type.startsWith("task.") ||
  type.startsWith("workspace.changeset.") ||
  type.startsWith("decision.") ||
  type.startsWith("memory.");

export interface MessageRun {
  /** Consecutive agent messages since the last state change or human message (capped at the limit + 2). */
  length: number;
  /** The agents who sent them. */
  authors: string[];
  /** The sequence of the earliest message counted. */
  first_sequence: number | null;
}

/**
 * The run of consecutive agent messages at the end of the room's ledger (§17.6), derived from
 * the events alone, so there is no counter to keep in step and a restart loses nothing. Walking
 * back from the newest event: an agent's `message.sent` extends the run; a human's
 * `message.sent` or any task, ChangeSet, decision or memory event ends it; other events (joins,
 * denials, health, edits) neither extend nor end it.
 */
export async function currentMessageRun(client: PoolClient, roomId: string): Promise<MessageRun> {
  // Only the events that can extend or end a run are read (so denials, health and the like
  // can't crowd the window and hide a loop or lift a throttle), and only enough of them to
  // tell whether the run is past the limit: it is capped at LIMIT + 2 messages back.
  const { rows } = await client.query<{ sequence: string; type: string; actor_id: string }>(
    `SELECT sequence, type, actor_id FROM events
     WHERE room_id = $1
       AND (type = 'message.sent' OR type ~ '^(task|decision|memory)\\.' OR type ~ '^workspace\\.changeset\\.')
     ORDER BY sequence DESC LIMIT $2`,
    [roomId, LOOP_MESSAGE_LIMIT + 2],
  );
  const senders = [
    ...new Set(rows.filter((r) => r.type === "message.sent").map((r) => r.actor_id)),
  ];
  const kinds = new Map<string, string>();
  if (senders.length > 0) {
    const { rows: people } = await client.query<{ id: string; kind: string }>(
      "SELECT id, kind FROM participants WHERE room_id = $1 AND id = ANY($2::text[])",
      [roomId, senders],
    );
    for (const p of people) kinds.set(p.id, p.kind);
  }
  const authors = new Set<string>();
  let length = 0;
  let first: number | null = null;
  for (const r of rows) {
    if (r.type === "message.sent") {
      if (kinds.get(r.actor_id) !== "AGENT") break;
      length += 1;
      authors.add(r.actor_id);
      first = Number(r.sequence);
    } else if (isStateChange(r.type)) {
      break;
    }
  }
  return { length, authors: [...authors], first_sequence: first };
}

export interface LoopCheck {
  /** Set when this very message is the one that tips the room into a loop. */
  detected?: { event: EmittedEvent & { actor_id: string }; participants: string[] };
}

/**
 * Loop protection for `messages.send` (T411, §17.6), run before the message is written.
 *
 * If more than {@link LOOP_MESSAGE_LIMIT} consecutive agent messages from two or more agents
 * have gone by with no state change, the room is in a loop and each of those agents is throttled
 * to one message a minute: a send sooner is `RATE_LIMITED` (retryable, with
 * `details.retry_after_seconds`). Humans and agents outside the loop are not throttled, and any
 * task, ChangeSet, decision or memory event, or a human's message, resets it. The message that
 * makes the run exceed the limit is accepted, and emits `loop.detected` plus an inbox item for
 * the lead and the owner, once per loop.
 */
export async function checkLoopProtection(
  client: PoolClient,
  roomId: string,
  sender: { id: string; kind: string },
): Promise<LoopCheck> {
  if (sender.kind !== "AGENT") return {};
  const run = await currentMessageRun(client, roomId);
  const looping = run.length > LOOP_MESSAGE_LIMIT && run.authors.length >= 2;

  if (looping && run.authors.includes(sender.id)) {
    const { rows } = await client.query<{ wait: number | null }>(
      `SELECT ceil(extract(epoch FROM (max(created_at) + make_interval(secs => $3) - clock_timestamp())))::int AS wait
       FROM messages WHERE room_id = $1 AND author_id = $2`,
      [roomId, sender.id, LOOP_THROTTLE_SECONDS],
    );
    const wait = rows[0]?.wait;
    if (wait !== null && wait !== undefined && wait > 0) {
      throw new CrossoverError(
        "RATE_LIMITED",
        "Agents in this room are looping with no progress; messages are limited to one a minute until something changes",
        {
          details: {
            reason: "loop_throttle",
            retry_after_seconds: wait,
            consecutive_agent_messages: run.length,
          },
        },
      );
    }
  }

  // This message makes the run one longer. Announce the loop at the transition from "not a
  // loop" to "a loop", whichever way it happens: a run of two agents crossing the limit, or
  // a long monologue that a second agent joins.
  const authors = new Set([...run.authors, sender.id]);
  const loopingAfter = run.length + 1 > LOOP_MESSAGE_LIMIT && authors.size >= 2;
  if (!looping && loopingAfter) {
    const participants = [...authors].sort();
    const { rows: leaders } = await client.query<{ id: string }>(
      `SELECT id FROM participants
       WHERE room_id = $1 AND status <> 'REMOVED' AND (role = 'LEAD' OR authority = 'OWNER')
       ORDER BY id`,
      [roomId],
    );
    for (const { id } of leaders) {
      await deliverInbox(client, roomId, id, {
        kind: "LOOP_DETECTED",
        ref: { kind: "participant", id: sender.id },
        summary: `${participants.length} agents have exchanged ${run.length + 1} messages with no task, ChangeSet, decision or memory change; their messages are limited to one a minute until something changes.`,
        author_id: "system",
      });
    }
    return {
      detected: {
        participants,
        event: {
          type: "loop.detected",
          actor_id: "system",
          payload: {
            participants,
            consecutive_messages: run.length + 1,
            first_sequence: run.first_sequence,
            throttle_seconds: LOOP_THROTTLE_SECONDS,
            notified: leaders.map((l) => l.id),
          },
        },
      },
    };
  }
  return {};
}
