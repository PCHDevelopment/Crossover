import { withTransaction, type Pool, type PoolClient } from "@crossover/db";
import { CrossoverError } from "@crossover/protocol";
import type { Dispatcher, EmittedEvent } from "../../dispatcher.js";
import { deliverInbox } from "../inbox/inbox.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_NOTICE_MS = 7 * DAY_MS;

export interface RoomRetentionSweeperOptions {
  pool: Pool;
  dispatcher: Dispatcher;
  /** Remove the room's repository/workspace directories and sandbox resources. Safe to retry. */
  purgeWorkspace: (roomId: string, repoPath: string | null) => Promise<void>;
  intervalMs?: number;
  now?: () => Date;
  onError?: (error: unknown, roomId?: string) => void;
}

interface RetentionCandidate {
  id: string;
  archived_at: Date;
  retention_days: number;
  retention_notice_sent_at: Date | null;
  purge_started_at: Date | null;
}

/** Periodically notifies owners and deletes expired archived rooms on their lease holder. */
export class RoomRetentionSweeper {
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly onError: (error: unknown, roomId?: string) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<number> | undefined;

  constructor(private readonly options: RoomRetentionSweeperOptions) {
    this.intervalMs = options.intervalMs ?? 30_000;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1) {
      throw new RangeError("Room retention sweep interval must be a positive safe integer");
    }
    this.now = options.now ?? (() => new Date());
    this.onError =
      options.onError ??
      ((error, roomId) => console.error("room retention sweep failed", roomId, error));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => this.onError(error));
    }, this.intervalMs);
    this.timer.unref();
  }

  tick(): Promise<number> {
    this.running ??= this.sweep().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }

  private async sweep(): Promise<number> {
    const rooms = this.options.dispatcher.leases.heldRooms();
    if (rooms.length === 0) return 0;
    const now = this.now();
    const { rows } = await this.options.pool.query<RetentionCandidate>(
      `SELECT id, archived_at, retention_days, retention_notice_sent_at, purge_started_at
         FROM rooms
        WHERE status = 'ARCHIVED' AND archived_at IS NOT NULL AND id = ANY($1::text[])
          AND (purge_started_at IS NOT NULL OR
               archived_at + make_interval(days => retention_days::int) <=
                 ($2::timestamptz + interval '7 days'))
        ORDER BY id`,
      [rooms, now],
    );

    let changed = 0;
    for (const candidate of rows) {
      try {
        if (await this.sendNotice(candidate.id, now)) changed++;
        if (
          candidate.purge_started_at ||
          candidate.archived_at.getTime() + candidate.retention_days * DAY_MS <= now.getTime()
        ) {
          if (await this.purge(candidate.id, now)) changed++;
        }
      } catch (error) {
        this.onError(error, candidate.id);
      }
    }
    return changed;
  }

  private async sendNotice(roomId: string, now: Date): Promise<boolean> {
    const { result } = await this.options.dispatcher.runSystem(
      roomId,
      "rooms.retention_notice",
      async ({ client }) => {
        const { rows } = await client.query<{
          owner_id: string;
          status: string;
          archived_at: Date | null;
          retention_days: number;
          retention_notice_sent_at: Date | null;
          purge_started_at: Date | null;
        }>(
          `SELECT owner_id, status, archived_at, retention_days,
                  retention_notice_sent_at, purge_started_at
             FROM rooms WHERE id = $1 FOR UPDATE`,
          [roomId],
        );
        const room = rows[0];
        if (
          !room ||
          room.status !== "ARCHIVED" ||
          !room.archived_at ||
          room.retention_notice_sent_at ||
          room.purge_started_at
        )
          return { result: false, events: [] };
        const deadline = new Date(room.archived_at.getTime() + room.retention_days * DAY_MS);
        if (
          deadline.getTime() <= now.getTime() ||
          deadline.getTime() > now.getTime() + RETENTION_NOTICE_MS
        ) {
          return { result: false, events: [] };
        }
        const summary = `This room is scheduled for permanent deletion on ${deadline.toISOString()}. Unarchive it or extend retention before then.`;
        const inboxEvents: EmittedEvent[] = [];
        await deliverInbox(
          client,
          roomId,
          room.owner_id,
          {
            kind: "ROOM_RETENTION",
            ref: { kind: "room", id: roomId },
            summary,
            author_id: "system",
          },
          inboxEvents,
        );
        await client.query(
          `UPDATE rooms SET retention_notice_sent_at = $2 WHERE id = $1 AND retention_notice_sent_at IS NULL`,
          [roomId, now],
        );
        return {
          result: true,
          events: inboxEvents.map((event) => ({ ...event, actor_id: event.actor_id ?? "system" })),
        };
      },
      { allowReadOnly: true, whenFrozen: () => false },
    );
    return result;
  }

  private async purge(roomId: string, now: Date): Promise<boolean> {
    const { dispatcher, pool, purgeWorkspace } = this.options;
    return dispatcher.actors.get(roomId).submit(async () => {
      let token = await dispatcher.leases.ensure(roomId);
      const started = await withTransaction(pool, async (client) => {
        const room = await loadArchivedRoom(client, roomId, true);
        if (!room || (!room.purge_started_at && retentionDeadline(room) > now.getTime()))
          return null;
        await assertCurrentLease(client, roomId, dispatcher.leases.nodeId, token);
        if (!room.purge_started_at) {
          await client.query(
            `UPDATE rooms SET purge_started_at = $2, purge_phase = 'WORKSPACE' WHERE id = $1`,
            [roomId, now],
          );
        }
        const { rows } = await client.query<{ repo_path: string }>(
          "SELECT repo_path FROM workspaces WHERE room_id = $1",
          [roomId],
        );
        return {
          phase: room.purge_phase ?? "WORKSPACE",
          repo_path: rows[0]?.repo_path ?? null,
        };
      });
      if (!started) return false;

      if (started.phase === "WORKSPACE") {
        await purgeWorkspace(roomId, started.repo_path);
        token = await dispatcher.leases.ensure(roomId);
        const advanced = await withTransaction(pool, async (client) => {
          const room = await loadArchivedRoom(client, roomId, true);
          if (!room || !room.purge_started_at || room.purge_phase !== "WORKSPACE") return false;
          await assertCurrentLease(client, roomId, dispatcher.leases.nodeId, token);
          await client.query("UPDATE rooms SET purge_phase = 'DATABASE' WHERE id = $1", [roomId]);
          return true;
        });
        if (!advanced) return false;
      }

      token = await dispatcher.leases.ensure(roomId);
      const deleted = await withTransaction(pool, async (client) => {
        const room = await loadArchivedRoom(client, roomId, true);
        if (!room || !room.purge_started_at || room.purge_phase !== "DATABASE") return false;
        await assertCurrentLease(client, roomId, dispatcher.leases.nodeId, token);
        await deleteRoomRows(client, roomId);
        await client.query(
          `INSERT INTO room_deletion_audit (room_id, owner_id, archived_at, retention_days)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (room_id) DO NOTHING`,
          [roomId, room.owner_id, room.archived_at, room.retention_days],
        );
        await client.query("DELETE FROM room_leases WHERE room_id = $1", [roomId]);
        await client.query("DELETE FROM rooms WHERE id = $1", [roomId]);
        return true;
      });
      if (deleted) dispatcher.leases.forget(roomId);
      return deleted;
    });
  }
}

async function loadArchivedRoom(
  client: PoolClient,
  roomId: string,
  forUpdate: boolean,
): Promise<{
  owner_id: string;
  archived_at: Date;
  retention_days: number;
  purge_started_at: Date | null;
  purge_phase: "WORKSPACE" | "DATABASE" | null;
} | null> {
  const { rows } = await client.query<{
    owner_id: string;
    archived_at: Date | null;
    retention_days: number;
    purge_started_at: Date | null;
    purge_phase: "WORKSPACE" | "DATABASE" | null;
  }>(
    `SELECT owner_id, archived_at, retention_days, purge_started_at, purge_phase
       FROM rooms WHERE id = $1 AND status = 'ARCHIVED' ${forUpdate ? "FOR UPDATE" : ""}`,
    [roomId],
  );
  const room = rows[0];
  if (!room || !room.archived_at) return null;
  return { ...room, archived_at: room.archived_at };
}

function retentionDeadline(room: { archived_at: Date; retention_days: number }): number {
  return room.archived_at.getTime() + room.retention_days * DAY_MS;
}

async function assertCurrentLease(
  client: PoolClient,
  roomId: string,
  nodeId: string,
  token: number,
): Promise<void> {
  const { rows } = await client.query<{ node_id: string; fencing_token: string; expires_at: Date }>(
    `SELECT node_id, fencing_token::text, expires_at
       FROM room_leases WHERE room_id = $1 FOR UPDATE`,
    [roomId],
  );
  const lease = rows[0];
  if (
    !lease ||
    lease.node_id !== nodeId ||
    Number(lease.fencing_token) !== token ||
    lease.expires_at.getTime() <= Date.now()
  ) {
    throw new CrossoverError("STALE_FENCE", `Room ${roomId} is no longer owned by this node`, {
      details: { room_id: roomId, node_id: nodeId },
    });
  }
}

async function deleteRoomRows(client: PoolClient, roomId: string): Promise<void> {
  const participantIds = "SELECT id FROM participants WHERE room_id = $1";
  await client.query("DELETE FROM auth_tokens WHERE room_id = $1", [roomId]);
  await client.query(`DELETE FROM idempotency_keys WHERE participant_id IN (${participantIds})`, [
    roomId,
  ]);
  await client.query("DELETE FROM tool_invocations WHERE room_id = $1", [roomId]);
  await client.query("DELETE FROM invites WHERE room_id = $1", [roomId]);
  await client.query("DELETE FROM capability_grants WHERE room_id = $1", [roomId]);
  await client.query("DELETE FROM inbox_items WHERE room_id = $1", [roomId]);
  await client.query("DELETE FROM wake_windows WHERE room_id = $1", [roomId]);
  await client.query("DELETE FROM approvals WHERE room_id = $1", [roomId]);
  await client.query("DELETE FROM task_reviews WHERE room_id = $1", [roomId]);
  await client.query("DELETE FROM tasks WHERE room_id = $1", [roomId]);
  await client.query("UPDATE messages SET reply_to = NULL WHERE room_id = $1", [roomId]);
  await client.query("DELETE FROM messages WHERE room_id = $1", [roomId]);
  await client.query("DELETE FROM decision_positions WHERE room_id = $1", [roomId]);
  await client.query("UPDATE decisions SET supersedes = NULL WHERE room_id = $1", [roomId]);
  await client.query("DELETE FROM decisions WHERE room_id = $1", [roomId]);
  await client.query("DELETE FROM events WHERE room_id = $1", [roomId]);
  await client.query("DELETE FROM memory_revisions WHERE room_id = $1", [roomId]);
  await client.query("DELETE FROM memory_entries WHERE room_id = $1", [roomId]);
  await client.query("DELETE FROM checkpoints WHERE room_id = $1", [roomId]);
  await client.query("DELETE FROM health_runs WHERE room_id = $1", [roomId]);
  await client.query("DELETE FROM health_install_runs WHERE room_id = $1", [roomId]);
  await client.query("DELETE FROM upstreams WHERE room_id = $1", [roomId]);
  await client.query("DELETE FROM integrations WHERE room_id = $1", [roomId]);
  await client.query("DELETE FROM integration_room_keys WHERE room_id = $1", [roomId]);
  await client.query("DELETE FROM sandboxes WHERE room_id = $1", [roomId]);

  // The workspace schema has cycles between conflicts, ChangeSets and revisions. Null their
  // optional links first, then remove the graph from its leaves inward.
  await client.query("UPDATE changesets SET conflict_id = NULL WHERE room_id = $1", [roomId]);
  await client.query("UPDATE conflicts SET resolution_changeset_id = NULL WHERE room_id = $1", [
    roomId,
  ]);
  await client.query("UPDATE workspace_revisions SET changeset_id = NULL WHERE room_id = $1", [
    roomId,
  ]);
  await client.query("UPDATE changesets SET applied_revision = NULL WHERE room_id = $1", [roomId]);
  await client.query("DELETE FROM conflicts WHERE room_id = $1", [roomId]);
  await client.query("DELETE FROM file_revisions WHERE room_id = $1", [roomId]);
  await client.query("DELETE FROM changesets WHERE room_id = $1", [roomId]);
  await client.query("DELETE FROM workspace_revisions WHERE room_id = $1", [roomId]);
  await client.query("DELETE FROM workspaces WHERE room_id = $1", [roomId]);

  await client.query(`DELETE FROM participants WHERE room_id = $1`, [roomId]);
}
