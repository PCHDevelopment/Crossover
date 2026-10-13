import { withTransaction } from "@crossover/db";
import { appendEvents } from "@crossover/ledger";
import { CrossoverError } from "@crossover/protocol";
import type { Principal } from "../principal.js";
import type { DispatcherCore } from "./core.js";
import { afterCommitWork } from "./delivery.js";

/**
 * Append `capability.denied` for a command that failed on a denial, in a transaction of its
 * own: the command's has rolled back, so this is the only trace it leaves (T215). Never
 * throws; `token` is the room lease's fencing token held by the caller.
 */
export async function recordDenial(
  core: DispatcherCore,
  principal: Principal,
  envelope: { method: string; id: string },
  error: unknown,
  token: number,
): Promise<void> {
  const info = typeof error === "object" && error !== null ? core.denials.get(error) : undefined;
  if (!info) return;
  const room_id = principal.room_id;
  try {
    const events = await withTransaction(core.pool, (client) =>
      appendEvents(
        client,
        room_id,
        [
          {
            type: "capability.denied",
            actor_id: principal.participant_id,
            causation_id: envelope.id,
            payload: { ...info, method: envelope.method },
          },
        ],
        token,
      ),
    );
    await afterCommitWork(core, room_id, envelope, [], {
      response: undefined,
      events,
      replayed: false,
    });
  } catch (err) {
    if (err instanceof CrossoverError && err.code === "STALE_FENCE") core.leases.forget(room_id);
    try {
      core.onDenialRecordError(err, {
        method: envelope.method,
        command_id: envelope.id,
        room_id,
        action: info.action,
      });
    } catch {
      // A broken error handler must not change the command's outcome.
    }
  }
}

/** What a `capability.denied` event says about a refused authorization (T215). */
export interface DenialInfo {
  action: string;
  resource: Record<string, string | number | boolean>;
  missing_capability: string;
  reason?: string;
  /** Set when the check was for another participant (`ctx.authorizeAs`). */
  on_behalf_of?: string;
}

/** Keep the event small and free of anything a command put in the resource but the policy didn't need. */
export function denialOf(
  action: string,
  resource: { room_id: string; [key: string]: unknown },
  error: CrossoverError,
): DenialInfo {
  const kept: DenialInfo["resource"] = {};
  for (const [key, value] of Object.entries(resource).slice(0, 12)) {
    if (key === "room_id") continue;
    if (typeof value === "string") kept[key] = value.slice(0, 256);
    else if (typeof value === "number" || typeof value === "boolean") kept[key] = value;
  }
  const details = error.details ?? {};
  const missing =
    typeof details.missing_capability === "string" ? details.missing_capability : action;
  return {
    action: action.slice(0, 512),
    resource: kept,
    missing_capability: missing.slice(0, 512),
    ...(typeof details.reason === "string" ? { reason: details.reason } : {}),
  };
}
