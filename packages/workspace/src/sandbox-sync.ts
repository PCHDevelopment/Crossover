import type { Dispatcher } from "@crossover/kernel";
import { CrossoverError } from "@crossover/protocol";
import { z } from "zod";
import type { ExecutionService, SandboxSyncResult } from "./execution.js";

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
    prepare: async (ctx) => execution.syncWorkingCopy(ctx.room_id, ctx.principal.participant_id),
    execute: async (ctx) => {
      const prepared = ctx.prepared as SandboxSyncResult | undefined;
      if (!prepared) throw new CrossoverError("UNAVAILABLE", "Sandbox sync was not prepared");
      const { response, event } = prepared;
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
