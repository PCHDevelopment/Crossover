import { type RoomEvent } from "@crossover/protocol";
import type { EventPublisher } from "../publisher.js";

/**
 * After a commit: run the command's `afterCommit` callbacks on the actor, so no other
 * command for the room can slip in between the commit and (say) the Git ref update (a
 * replay registers none), then publish the events (never for a replay).
 */
export async function afterCommitWork(
  core: DispatcherCore,
  room_id: string,
  envelope: { method: string; id: string },
  callbacks: readonly (() => void | Promise<void>)[],
  result: DispatchResult,
): Promise<void> {
  for (const callback of callbacks) {
    try {
      await callback();
    } catch (error) {
      core.onAfterCommitError(error, {
        method: envelope.method,
        command_id: envelope.id,
        room_id,
      });
    }
  }
  if (core.publisher && !result.replayed && result.events.length > 0) {
    await publish(core, core.publisher, room_id, envelope, result.events);
  }
}

import type { DispatcherCore } from "./core.js";
import type { DispatchResult } from "./types.js";

export async function publish(
  core: DispatcherCore,
  publisher: EventPublisher,
  room_id: string,
  envelope: { method: string; id: string },
  events: RoomEvent[],
): Promise<void> {
  const info = { method: envelope.method, command_id: envelope.id, room_id };
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      publisher.publish(room_id, events),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`publish timed out after ${core.publishTimeoutMs} ms`)),
          core.publishTimeoutMs,
        );
      }),
    ]);
  } catch (error) {
    try {
      core.onPublishError(error, info);
    } catch {
      // A broken error handler must not fail a committed command either.
    }
  } finally {
    clearTimeout(timer);
  }
}
