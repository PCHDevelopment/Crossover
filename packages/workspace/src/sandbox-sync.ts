import type { Dispatcher } from "@crossover/kernel";
import { z } from "zod";
import type { ExecutionService } from "./execution.js";

export const sandboxSyncParamsSchema = z.strictObject({});

/** Rebase the caller's sandbox onto the current canonical head. */
export function registerSandboxSyncCommand(
  dispatcher: Dispatcher,
  execution: ExecutionService,
): void {
  dispatcher.registerCommand({
    method: "sandbox.sync",
    action: "sandbox.exec",
    mutating: true,
    params: sandboxSyncParamsSchema,
    execute: async (ctx) => {
      const { response, event } = await execution.syncWorkingCopy(
        ctx.room_id,
        ctx.principal.participant_id,
      );
      if (event)
        ctx.afterCommit(() => {
          void dispatcher
            .runSystem(ctx.room_id, "sandbox.sync", async () => ({
              result: undefined,
              events: [{ type: event.type, actor_id: event.actor_id, payload: event.payload }],
            }))
            .catch((error: unknown) =>
              console.error("Failed to publish sandbox sync event", {
                room_id: ctx.room_id,
                participant_id: ctx.principal.participant_id,
                error,
              }),
            );
        });
      return { response };
    },
  });
}
