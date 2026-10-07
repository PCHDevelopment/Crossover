import { z } from "zod";
import { createHmac, randomUUID } from "node:crypto";
import { withTransaction, type Pool } from "@crossover/db";
import { CrossoverError } from "@crossover/protocol";
import type { Dispatcher } from "../../dispatcher.js";

/** At most one wake-up per agent in this long; what arrives meanwhile is batched (§17.4). */
export const WAKE_WINDOW_MS = 30_000;
const ALGORITHM =
  "HMAC-SHA256 over `<timestamp>.<body>`, hex, header `X-Crossover-Signature: sha256=<hex>`";

/**
 * The key an agent signs-checks its wake-ups with: derived from the platform's key and the agent's
 * id, so nothing is stored and it never changes. The agent reads it with `participants.wake_secret`.
 */
export function wakeSecretFor(platformKey: string, participantId: string): string {
  return createHmac("sha256", platformKey).update(`wake-webhook:v1:${participantId}`).digest("hex");
}

/** The signature header value for a delivery: `sha256=` + HMAC-SHA256(secret, `<timestamp>.<body>`) in hex. */
export function signWake(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export interface WakeRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
}
/** How a wake-up leaves the platform. Resolves for a delivery the receiver accepted, rejects otherwise. */
export type WakeSender = (request: WakeRequest) => Promise<unknown>;

export interface WakeItem {
  id: string;
  kind: string;
  ref: { kind: string; id: string };
}

export interface WakeWebhookOptions {
  pool: Pool;
  /** The platform key wake secrets are derived from. */
  key: string;
  sender: WakeSender;
  /** Default 30 s. */
  windowMs?: number;
  /** Most items in one delivery; the rest go in the next window. Default 200. */
  batch?: number;
  /** Most deliveries in flight at once on this node. Default 8. */
  concurrency?: number;
  /** Most agents one tick takes up. Default 100. */
  agentsPerTick?: number;
  /** How often the service looks. Default 1000. */
  intervalMs?: number;
  now?: () => number;
  onError?: (error: unknown, info: { participant_id: string }) => void;
}

/** After this many failures in a row, the window stops widening (30 s × 2⁷ ≈ 1 h). */
const MAX_BACKOFF_STEPS = 7;

/**
 * Wake-up webhooks (T706, §17.4), as an outbox in PostgreSQL. An agent whose manifest has a
 * `wake_webhook_url` gets a signed POST when inbox items arrive for it: **at most one per agent
 * per 30 s across all nodes**, so a burst is one notification listing everything that arrived (up
 * to 200 items; the rest go in the next window). The first item after a quiet spell goes out at
 * once.
 *
 * Any number of nodes can run the service. An item is waiting while its `wake_notified_at` is null
 * (set at insert for anyone who isn't an agent with a webhook). A node **claims** an agent by
 * moving that agent's `wake_windows` row forward (`FOR UPDATE SKIP LOCKED`, so two nodes never
 * both claim it; the claim is one short transaction, not held across the send), reads its waiting
 * items, sends, and marks them notified. Nothing lives in memory: a restart in the middle of a
 * window keeps the limit and loses nothing, and an item that commits late is found on the next
 * tick like any other. A claim opens the window whether or not the send works; **a failed
 * delivery is tried again after a window that doubles with each failure in a row** (up to about
 * an hour), and the items stay waiting. Delivery is at least once: a node that dies between the
 * send and the mark sends them again.
 *
 * Sends run concurrently (up to `concurrency`), each under an overall deadline in the sender, so
 * one slow receiver delays no one else. The body names ids, kinds and refs only, never the items'
 * text. Agents that are paused or removed, whose room isn't active, or that have no URL any more
 * are not called. Each delivery is signed with the agent's own secret (see {@link signWake});
 * headers: `X-Crossover-Delivery`, `X-Crossover-Timestamp` (unix seconds), `X-Crossover-Signature`.
 */
export class WakeWebhookService {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<number> | undefined;
  private readonly now: () => number;

  constructor(private readonly o: WakeWebhookOptions) {
    this.now = o.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) =>
        (this.o.onError ?? console.error)(error, { participant_id: "*" }),
      );
    }, this.o.intervalMs ?? 1_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }

  /** Claim what is due and send it. Returns how many webhooks were delivered. */
  tick(): Promise<number> {
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(): Promise<number> {
    const { pool } = this.o;
    const window = this.o.windowMs ?? WAKE_WINDOW_MS;
    const nowIso = new Date(this.now()).toISOString();
    // Agents with something waiting, whose room is active, **and whose window is open** (one in
    // backoff must not crowd out the rest), the longest-waiting first.
    const { rows: candidates } = await pool.query<{ participant_id: string }>(
      `SELECT i.participant_id
       FROM inbox_items i
       JOIN participants p ON p.id = i.participant_id AND p.room_id = i.room_id
       JOIN rooms r ON r.id = i.room_id
       LEFT JOIN wake_windows w ON w.participant_id = i.participant_id
       WHERE i.wake_notified_at IS NULL AND i.acked_at IS NULL
         AND p.kind = 'AGENT' AND p.status = 'ACTIVE' AND r.status = 'ACTIVE'
         AND p.agent_manifest ->> 'wake_webhook_url' IS NOT NULL
         AND (w.participant_id IS NULL
              OR w.last_sent_at + make_interval(secs => ($1::float8 / 1000) * power(2, least(w.failures, $2))) <= $3::timestamptz)
       GROUP BY i.participant_id, w.last_sent_at
       ORDER BY w.last_sent_at NULLS FIRST, i.participant_id COLLATE "C"
       LIMIT $4`,
      [window, MAX_BACKOFF_STEPS, nowIso, this.o.agentsPerTick ?? 100],
    );
    let delivered = 0;
    const queue = candidates.map((c) => c.participant_id);
    // Each worker claims an agent right before sending to it, so a claim never waits behind other
    // sends (and so never lapses into another node's hands before it is used).
    const worker = async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const claim = await this.claim(next);
        if (claim && (await this.deliver(claim))) delivered += 1;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.o.concurrency ?? 8, queue.length) }, worker),
    );
    return delivered;
  }

  /**
   * Take an agent's window if it is due, in one short transaction: no other node can, now, and
   * the agent's next try is at least a window away whatever happens to this one.
   */
  private async claim(participantId: string): Promise<Claim | undefined> {
    const window = this.o.windowMs ?? WAKE_WINDOW_MS;
    const nowIso = new Date(this.now()).toISOString();
    return withTransaction(this.o.pool, async (client) => {
      await client.query(
        `INSERT INTO wake_windows (participant_id, room_id, last_sent_at, failures)
         SELECT id, room_id, 'epoch', 0 FROM participants WHERE id = $1
         ON CONFLICT (participant_id) DO NOTHING`,
        [participantId],
      );
      const { rows } = await client.query<{ room_id: string; failures: number }>(
        `SELECT room_id, failures FROM wake_windows
         WHERE participant_id = $1
           AND last_sent_at + make_interval(secs => ($2::float8 / 1000) * power(2, least(failures, $3))) <= $4::timestamptz
         FOR UPDATE SKIP LOCKED`,
        [participantId, window, MAX_BACKOFF_STEPS, nowIso],
      );
      const row = rows[0];
      if (!row) return undefined;
      await client.query(
        "UPDATE wake_windows SET last_sent_at = $2::timestamptz WHERE participant_id = $1",
        [participantId, nowIso],
      );
      return { participantId, roomId: row.room_id, failures: row.failures };
    });
  }

  private report(error: unknown, participantId: string): void {
    try {
      (this.o.onError ?? ((e: unknown) => console.warn("wake webhook failed", e)))(error, {
        participant_id: participantId,
      });
    } catch {
      // a broken handler changes nothing
    }
  }

  /** Send what is waiting for a claimed agent; true if the receiver accepted it. */
  private async deliver(claim: Claim): Promise<boolean> {
    const { pool } = this.o;
    const { participantId } = claim;
    try {
      // Whatever was acknowledged before it could be announced needs no announcing.
      await pool.query(
        `UPDATE inbox_items SET wake_notified_at = clock_timestamp()
         WHERE participant_id = $1 AND wake_notified_at IS NULL AND acked_at IS NOT NULL`,
        [participantId],
      );
      const { rows: who } = await pool.query<{ url: string | null }>(
        `SELECT p.agent_manifest ->> 'wake_webhook_url' AS url
         FROM participants p JOIN rooms r ON r.id = p.room_id
         WHERE p.id = $1 AND p.kind = 'AGENT' AND p.status = 'ACTIVE' AND r.status = 'ACTIVE'`,
        [participantId],
      );
      const url = who[0]?.url;
      if (!url) return false; // paused, removed or no URL now: the items wait (or are never wanted)
      const { rows } = await pool.query<{
        id: string;
        kind: string;
        ref: { kind?: string; id?: string };
      }>(
        `SELECT id, kind, ref FROM inbox_items
         WHERE participant_id = $1 AND wake_notified_at IS NULL AND acked_at IS NULL
         ORDER BY created_at, id COLLATE "C" LIMIT $2`,
        [participantId, (this.o.batch ?? 200) + 1],
      );
      if (rows.length === 0) return false;
      const more = rows.length > (this.o.batch ?? 200);
      const items: WakeItem[] = rows.slice(0, this.o.batch ?? 200).map((r) => ({
        id: r.id,
        kind: r.kind,
        ref: { kind: String(r.ref.kind ?? ""), id: String(r.ref.id ?? "") },
      }));
      const sentAt = new Date(this.now());
      const body = JSON.stringify({
        type: "inbox.wake",
        room_id: claim.roomId,
        participant_id: participantId,
        count: items.length,
        items,
        more,
        sent_at: sentAt.toISOString(),
      });
      const timestamp = String(Math.floor(sentAt.getTime() / 1000));
      await this.o.sender({
        url,
        body,
        headers: {
          "x-crossover-delivery": randomUUID(),
          "x-crossover-timestamp": timestamp,
          "x-crossover-signature": signWake(
            wakeSecretFor(this.o.key, participantId),
            timestamp,
            body,
          ),
          "user-agent": "Crossover-Webhook/1",
        },
      });
      // The receiver has it. A failure to record that is the database's, not the endpoint's: no
      // backoff for the agent; the items are announced again next window (at least once).
      try {
        await pool.query(
          "UPDATE inbox_items SET wake_notified_at = clock_timestamp() WHERE id = ANY($1::text[])",
          [items.map((i) => i.id)],
        );
        if (claim.failures > 0) {
          await pool.query("UPDATE wake_windows SET failures = 0 WHERE participant_id = $1", [
            participantId,
          ]);
        }
      } catch (markError) {
        this.report(markError, participantId);
      }
      return true;
    } catch (error) {
      // The items stay waiting; the window opens again later, wider for each failure in a row.
      await pool
        .query("UPDATE wake_windows SET failures = failures + 1 WHERE participant_id = $1", [
          participantId,
        ])
        .catch(() => undefined);
      this.report(error, participantId);
      return false;
    }
  }
}

interface Claim {
  participantId: string;
  roomId: string;
  failures: number;
}

/**
 * Register `participants.wake_secret` (T706): an agent reads the secret its wake-ups are signed
 * with (self only; humans have no wake-ups). The derivation is
 * {@link wakeSecretFor}; the signature scheme is {@link signWake}. Without a platform key
 * (`WAKE_WEBHOOK_KEY`) there are no wake-ups and the command says so.
 */
export function registerWakeSecretCommand(dispatcher: Dispatcher, key: string | undefined): void {
  dispatcher.registerCommand({
    method: "participants.wake_secret",
    action: "participants.read",
    mutating: false,
    view: "own",
    params: z.strictObject({}),
    execute: async (ctx) => {
      if (ctx.principal.kind !== "AGENT") {
        throw new CrossoverError("VALIDATION", "Only an agent has wake-ups", {
          details: { reason: "not_an_agent" },
        });
      }
      if (!key) {
        throw new CrossoverError(
          "VALIDATION",
          "Wake-up webhooks aren't configured on this server",
          {
            details: { reason: "not_configured" },
          },
        );
      }
      return {
        response: {
          secret: wakeSecretFor(key, ctx.principal.participant_id),
          algorithm: ALGORITHM,
        },
      };
    },
  });
}
