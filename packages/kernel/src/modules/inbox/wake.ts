import { z } from "zod";
import { createHmac, randomUUID } from "node:crypto";
import type { Pool } from "@crossover/db";
import { CrossoverError } from "@crossover/protocol";
import type { Dispatcher } from "../../dispatcher.js";

/** At most one wake-up per agent in this long; what arrives meanwhile is batched (§17.4). */
export const WAKE_WINDOW_MS = 30_000;
const MAX_PENDING_PER_AGENT = 200;
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
  /** Look at items at least this old, so a transaction that commits late isn't passed over. Default 1000. */
  lagMs?: number;
  /** How often the service looks. Default 1000. */
  intervalMs?: number;
  now?: () => number;
  onError?: (error: unknown, info: { participant_id: string }) => void;
}

interface ItemRow {
  id: string;
  room_id: string;
  participant_id: string;
  kind: string;
  ref: { kind: string; id: string };
  ts: string;
}

interface Pending {
  room_id: string;
  items: WakeItem[];
  dropped: number;
}

/**
 * Wake-up webhooks (T706, §17.4). An agent whose manifest has a `wake_webhook_url` gets a signed
 * POST when new inbox items arrive for it: **at most one per agent per 30 s**, so a burst is one
 * notification listing everything that arrived (up to 200 items; `dropped` counts any beyond).
 * The first item after a quiet spell goes out at once.
 *
 * The body names ids, kinds and refs only, never the items' text (which can quote other
 * participants): the agent reads its inbox (`inbox.list`) for the rest. Items acknowledged before
 * the send are left out, and an agent that is paused, removed or has no URL any more is not
 * called. A delivery that fails is kept and tried again in the next window. Each delivery is
 * signed with the agent's own secret (see {@link signWake}); the headers are `X-Crossover-Delivery`,
 * `X-Crossover-Timestamp` (unix seconds) and `X-Crossover-Signature`.
 *
 * Only items created after the service started are considered, and the service keeps its state
 * in memory: a restart can repeat a notification, never lose one that was still waiting for its window
 * beyond the restart itself.
 */
export class WakeWebhookService {
  private cursor: { ts: string; id: string } | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly lastSent = new Map<string, number>();
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

  /** Look for new items and send what is due. Returns how many webhooks were sent. */
  tick(): Promise<number> {
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(): Promise<number> {
    await this.collect();
    return this.flush();
  }

  private async collect(): Promise<void> {
    const { pool } = this.o;
    if (!this.cursor) {
      const { rows } = await pool.query<{ ts: string | null; id: string | null }>(
        `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts, id
         FROM inbox_items ORDER BY created_at DESC, id COLLATE "C" DESC LIMIT 1`,
      );
      this.cursor = rows[0]?.ts
        ? { ts: rows[0].ts, id: rows[0].id ?? "" }
        : { ts: "1970-01-01T00:00:00.000000Z", id: "" };
      return; // what existed before the service started isn't its to announce
    }
    const lag = this.o.lagMs ?? 1_000;
    let cursor: { ts: string; id: string } = this.cursor;
    for (;;) {
      const result: { rows: ItemRow[] } = await pool.query<ItemRow>(
        `SELECT id, room_id, participant_id, kind, ref,
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
         FROM inbox_items
         WHERE (created_at, id COLLATE "C") > ($1::timestamptz, $2)
           AND created_at <= clock_timestamp() - make_interval(secs => $3::float8 / 1000)
         ORDER BY created_at, id COLLATE "C" LIMIT 500`,
        [cursor.ts, cursor.id, lag],
      );
      const rows = result.rows;
      if (rows.length === 0) return;
      const last: ItemRow = rows[rows.length - 1]!;
      cursor = { ts: last.ts, id: last.id };
      this.cursor = cursor;
      const { rows: agents } = await pool.query<{ id: string }>(
        `SELECT id FROM participants
         WHERE id = ANY($1::text[]) AND kind = 'AGENT' AND status = 'ACTIVE'
           AND agent_manifest ->> 'wake_webhook_url' IS NOT NULL`,
        [[...new Set(rows.map((r) => r.participant_id))]],
      );
      const eligible = new Set(agents.map((a) => a.id));
      for (const row of rows) {
        if (!eligible.has(row.participant_id)) continue;
        const entry = this.pending.get(row.participant_id) ?? {
          room_id: row.room_id,
          items: [],
          dropped: 0,
        };
        entry.items.push({ id: row.id, kind: row.kind, ref: row.ref });
        if (entry.items.length > MAX_PENDING_PER_AGENT) {
          entry.items.shift();
          entry.dropped += 1;
        }
        this.pending.set(row.participant_id, entry);
      }
      if (rows.length < 500) return;
    }
  }

  private async flush(): Promise<number> {
    const window = this.o.windowMs ?? WAKE_WINDOW_MS;
    let sent = 0;
    for (const [participantId, entry] of [...this.pending]) {
      const last = this.lastSent.get(participantId);
      if (last !== undefined && this.now() - last < window) continue;
      const { rows: who } = await this.o.pool.query<{ url: string | null }>(
        `SELECT agent_manifest ->> 'wake_webhook_url' AS url FROM participants
         WHERE id = $1 AND kind = 'AGENT' AND status = 'ACTIVE'`,
        [participantId],
      );
      const url = who[0]?.url;
      const { rows: open } = await this.o.pool.query<{ id: string }>(
        "SELECT id FROM inbox_items WHERE id = ANY($1::text[]) AND acked_at IS NULL",
        [entry.items.map((i) => i.id)],
      );
      const stillOpen = new Set(open.map((r) => r.id));
      const items = entry.items.filter((i) => stillOpen.has(i.id));
      if (!url || items.length === 0) {
        this.pending.delete(participantId);
        continue;
      }
      const sentAt = new Date(this.now());
      const body = JSON.stringify({
        type: "inbox.wake",
        room_id: entry.room_id,
        participant_id: participantId,
        count: items.length + entry.dropped,
        items,
        dropped: entry.dropped,
        sent_at: sentAt.toISOString(),
      });
      const timestamp = String(Math.floor(sentAt.getTime() / 1000));
      this.lastSent.set(participantId, this.now());
      try {
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
        this.pending.delete(participantId);
        sent += 1;
      } catch (error) {
        // Kept, and tried again when the window has passed.
        try {
          (this.o.onError ?? ((e: unknown) => console.warn("wake webhook failed", e)))(error, {
            participant_id: participantId,
          });
        } catch {
          // a broken handler changes nothing
        }
      }
    }
    return sent;
  }
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
