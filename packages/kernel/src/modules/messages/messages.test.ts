import type { Pool } from "@crossover/db";
import { createTestDatabase, type TestDatabase } from "@crossover/db/testing";
import { authorize } from "@crossover/policy";
import { CrossoverError, newId } from "@crossover/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Dispatcher } from "../../dispatcher.js";
import type { Principal } from "../../principal.js";
import { MAX_BODY_BYTES, registerMessageCommands, type MessageView } from "./messages.js";

let db: TestDatabase;
let pool: Pool;
let n = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  pool = db.pool;
});

afterAll(async () => {
  await db.drop();
});

const cmd = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
  idempotency_key: `k-${++n}`,
});
const read = (method: string, params: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method,
  params,
});

async function add(
  room: string,
  role: string,
  kind: "HUMAN" | "AGENT" = "AGENT",
  status = "ACTIVE",
): Promise<Principal> {
  const id = newId("part");
  await pool.query(
    `INSERT INTO participants (id, room_id, kind, display_name, authority, role, status)
     VALUES ($1, $2, $3, $1, 'MEMBER', $4, $5)`,
    [id, room, kind, role, status],
  );
  return { participant_id: id, room_id: room, kind, authority: "MEMBER", role } as Principal;
}

async function setup() {
  const d = new Dispatcher({ pool, authorize, nodeId: `node-${++n}` });
  registerMessageCommands(d);
  const room = newId("room");
  await pool.query(
    `INSERT INTO rooms (id, slug, name, objective, owner_id) VALUES ($1, $1, 'n', 'o', 'x')`,
    [room],
  );
  return {
    d,
    room,
    a: await add(room, "DEVELOPER"),
    b: await add(room, "DEVELOPER"),
    reviewer: await add(room, "REVIEWER"),
    observer: await add(room, "OBSERVER"),
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const send = async (s: Setup, who: Principal, params: Record<string, unknown>) =>
  s.d.dispatch(who, cmd("messages.send", { body: "hello", ...params }));
const list = async (s: Setup, who: Principal, params: Record<string, unknown> = {}) =>
  (await s.d.dispatch(who, read("messages.list", params))).response as {
    messages: MessageView[];
    has_more: boolean;
  };

const rejects = async (p: Promise<unknown>, code: string) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CrossoverError);
  expect((err as CrossoverError).code).toBe(code);
  return err as CrossoverError;
};

describe("messages.send", () => {
  it("posts a message and emits message.sent carrying it", async () => {
    const s = await setup();
    const out = await send(s, s.a, {
      body: "Please look at this",
      mentions: [s.b.participant_id],
      refs: [{ kind: "task", id: "task_1" }],
    });
    const m = out.response as MessageView;
    expect(m).toMatchObject({
      room_id: s.room,
      author_id: s.a.participant_id,
      body: "Please look at this",
      mentions: [s.b.participant_id],
      refs: [{ kind: "task", id: "task_1" }],
      reply_to: null,
      edited_at: null,
    });
    expect(m.id).toMatch(/^msg_/);
    expect(out.events[0]).toMatchObject({
      type: "message.sent",
      actor_id: s.a.participant_id,
      payload: { message: { id: m.id, body: "Please look at this" } },
    });
    expect(out.events[1]).toMatchObject({
      type: "inbox.delivered",
      actor_id: "system",
      payload: {
        recipient_id: s.b.participant_id,
        item_id: expect.stringMatching(/^inbox_/),
        kind: "MENTION",
      },
    });
  });

  describe("mentions are explicit ids", () => {
    it("mentioning a non-participant → VALIDATION naming it", async () => {
      const s = await setup();
      const err = await rejects(
        send(s, s.a, { mentions: [s.b.participant_id, "part_nope"] }),
        "VALIDATION",
      );
      expect(err.message).toContain("part_nope");
      expect(err.details).toMatchObject({ unknown_mentions: ["part_nope"] });
      const { rows } = await pool.query("SELECT 1 FROM messages WHERE room_id = $1", [s.room]);
      expect(rows).toHaveLength(0);
    });

    it("a participant of another room, or a removed one, can't be mentioned", async () => {
      const s = await setup();
      const other = await setup();
      await rejects(send(s, s.a, { mentions: [other.a.participant_id] }), "VALIDATION");
      const gone = await add(s.room, "DEVELOPER", "AGENT", "REMOVED");
      await rejects(send(s, s.a, { mentions: [gone.participant_id] }), "VALIDATION");
    });

    it("duplicates collapse, and @names in the text are never parsed", async () => {
      const s = await setup();
      const m = (
        await send(s, s.a, {
          body: `hey @${s.b.participant_id} and @someone`,
          mentions: [s.b.participant_id, s.b.participant_id],
        })
      ).response as MessageView;
      expect(m.mentions).toEqual([s.b.participant_id]);
      const none = (await send(s, s.a, { body: `hey @${s.b.participant_id}` }))
        .response as MessageView;
      expect(none.mentions).toEqual([]);
    });

    it("paused and invited participants can be mentioned", async () => {
      const s = await setup();
      const paused = await add(s.room, "DEVELOPER", "AGENT", "PAUSED");
      const invited = await add(s.room, "DEVELOPER", "AGENT", "INVITED");
      await send(s, s.a, { mentions: [paused.participant_id, invited.participant_id] });
    });
  });

  describe("body", () => {
    it("is at most 32 KB (bytes) and not empty", async () => {
      const s = await setup();
      await send(s, s.a, { body: "x".repeat(MAX_BODY_BYTES) });
      await send(s, s.a, { body: "é".repeat(MAX_BODY_BYTES / 2) });
      for (const bad of [
        "x".repeat(MAX_BODY_BYTES + 1),
        "é".repeat(MAX_BODY_BYTES / 2 + 1),
        "",
        "   \n ",
      ]) {
        await rejects(send(s, s.a, { body: bad }), "VALIDATION");
      }
    });
  });

  it("validates refs, mentions and unknown fields", async () => {
    const s = await setup();
    for (const extra of [
      { refs: [{ kind: "Task", id: "x" }] },
      { refs: [{ kind: "task" }] },
      { refs: Array.from({ length: 21 }, () => ({ kind: "task", id: "x" })) },
      { mentions: Array.from({ length: 51 }, (_, i) => `part_${i}`) },
      { mentions: [""] },
      { surprise: true },
    ]) {
      await rejects(send(s, s.a, extra), "VALIDATION");
    }
  });

  it("replies only to a message of this room", async () => {
    const s = await setup();
    const other = await setup();
    const first = (await send(s, s.a, {})).response as MessageView;
    const foreign = (await send(other, other.a, {})).response as MessageView;
    const reply = (await send(s, s.b, { reply_to: first.id })).response as MessageView;
    expect(reply.reply_to).toBe(first.id);
    await rejects(send(s, s.b, { reply_to: foreign.id }), "VALIDATION");
    await rejects(send(s, s.b, { reply_to: "msg_nope" }), "VALIDATION");
  });

  it("is for roles with messages.send: observers can't post", async () => {
    const s = await setup();
    await rejects(send(s, s.observer, {}), "FORBIDDEN");
    await send(s, s.reviewer, {});
  });

  it("an agent owner posting about their task keeps the claim lease alive; other posters and refs don't", async () => {
    const s = await setup();
    const taskId = newId("task");
    await pool.query(
      `INSERT INTO tasks (id, room_id, title, created_by, status, owner_id, lease_expires_at)
       VALUES ($1, $2, 'T', $3, 'IN_PROGRESS', $3, clock_timestamp() + interval '1 minute')`,
      [taskId, s.room, s.a.participant_id],
    );
    const lease = async () =>
      new Date(
        (await pool.query("SELECT lease_expires_at FROM tasks WHERE id = $1", [taskId])).rows[0]
          .lease_expires_at,
      ).getTime() - Date.now();
    await send(s, s.b, { refs: [{ kind: "task", id: taskId }] }); // someone else
    expect(await lease()).toBeLessThan(2 * 60 * 1000);
    await send(s, s.a, { refs: [{ kind: "file", id: taskId }] }); // not a task ref
    expect(await lease()).toBeLessThan(2 * 60 * 1000);
    await send(s, s.a, { refs: [{ kind: "task", id: taskId }] });
    expect(await lease()).toBeGreaterThan(14 * 60 * 1000);
  });

  it("is idempotent per key", async () => {
    const s = await setup();
    const envelope = cmd("messages.send", { body: "once" });
    const x = await s.d.dispatch(s.a, envelope);
    const y = await s.d.dispatch(s.a, envelope);
    expect(y.replayed).toBe(true);
    expect((y.response as MessageView).id).toBe((x.response as MessageView).id);
    const { rows } = await pool.query("SELECT 1 FROM messages WHERE room_id = $1", [s.room]);
    expect(rows).toHaveLength(1);
  });
});

describe("messages.edit", () => {
  it("lets the author change the text; the original stays in the ledger", async () => {
    const s = await setup();
    const sent = await send(s, s.a, { body: "original" });
    const m = sent.response as MessageView;
    const out = await s.d.dispatch(s.a, cmd("messages.edit", { message_id: m.id, body: "fixed" }));
    expect(out.response).toMatchObject({ id: m.id, body: "fixed" });
    expect((out.response as MessageView).edited_at).not.toBeNull();
    expect(out.events[0]).toMatchObject({
      type: "message.edited",
      actor_id: s.a.participant_id,
      payload: { message_id: m.id, body: "fixed" },
    });
    const sentEvent = (
      await pool.query("SELECT payload FROM events WHERE room_id = $1 AND type = 'message.sent'", [
        s.room,
      ])
    ).rows[0];
    expect(sentEvent.payload.message.body).toBe("original");
    expect((await list(s, s.b)).messages[0]).toMatchObject({ body: "fixed" });
  });

  it("editing someone else's message → FORBIDDEN, whoever they are", async () => {
    const s = await setup();
    const m = (await send(s, s.a, { body: "mine" })).response as MessageView;
    for (const who of [s.b, s.reviewer, s.observer]) {
      await rejects(
        s.d.dispatch(who, cmd("messages.edit", { message_id: m.id, body: "x" })),
        "FORBIDDEN",
      );
    }
    expect((await list(s, s.a)).messages[0]!.body).toBe("mine");
  });

  it("validates the new text and answers NOT_FOUND for an unknown or other room's message", async () => {
    const s = await setup();
    const other = await setup();
    const m = (await send(s, s.a, {})).response as MessageView;
    const foreign = (await send(other, other.a, {})).response as MessageView;
    await rejects(
      s.d.dispatch(s.a, cmd("messages.edit", { message_id: m.id, body: " " })),
      "VALIDATION",
    );
    await rejects(
      s.d.dispatch(s.a, cmd("messages.edit", { message_id: foreign.id, body: "x" })),
      "NOT_FOUND",
    );
    await rejects(
      s.d.dispatch(s.a, cmd("messages.edit", { message_id: "msg_nope", body: "x" })),
      "NOT_FOUND",
    );
  });
});

describe("messages.list", () => {
  async function conversation(s: Setup, count: number): Promise<MessageView[]> {
    const out: MessageView[] = [];
    for (let i = 0; i < count; i++)
      out.push((await send(s, i % 2 ? s.a : s.b, { body: `m${i}` })).response as MessageView);
    return out;
  }

  it("returns the latest messages oldest first, with has_more", async () => {
    const s = await setup();
    const all = await conversation(s, 7);
    const page = await list(s, s.observer, { limit: 3 });
    expect(page.messages.map((m) => m.body)).toEqual(["m4", "m5", "m6"]);
    expect(page.has_more).toBe(true);
    const everything = await list(s, s.observer);
    expect(everything.messages.map((m) => m.id)).toEqual(all.map((m) => m.id));
    expect(everything.has_more).toBe(false);
  });

  it("pages back with before and forward with after, every message exactly once", async () => {
    const s = await setup();
    const all = await conversation(s, 11);
    const seen: string[] = [];
    let page = await list(s, s.a, { limit: 4 });
    seen.unshift(...page.messages.map((m) => m.id));
    while (page.has_more) {
      page = await list(s, s.a, { limit: 4, before: seen[0]! });
      seen.unshift(...page.messages.map((m) => m.id));
    }
    expect(seen).toEqual(all.map((m) => m.id));

    const forward: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const p = await list(s, s.a, { limit: 4, after: cursor ?? all[0]!.id });
      forward.push(...p.messages.map((m) => m.id));
      if (!p.has_more) break;
      cursor = p.messages.at(-1)!.id;
    }
    expect(forward).toEqual(all.slice(1).map((m) => m.id));
  });

  it("an anchor id that is unknown or in another room is NOT_FOUND; before and after together is VALIDATION", async () => {
    const s = await setup();
    const other = await setup();
    const foreign = (await send(other, other.a, {})).response as MessageView;
    const m = (await send(s, s.a, {})).response as MessageView;
    await rejects(s.d.dispatch(s.a, read("messages.list", { before: foreign.id })), "NOT_FOUND");
    await rejects(s.d.dispatch(s.a, read("messages.list", { after: "msg_nope" })), "NOT_FOUND");
    await rejects(
      s.d.dispatch(s.a, read("messages.list", { before: m.id, after: m.id })),
      "VALIDATION",
    );
    for (const limit of [0, 101, 1.5])
      await rejects(s.d.dispatch(s.a, read("messages.list", { limit })), "VALIDATION");
  });

  it("only lists the caller's room", async () => {
    const s = await setup();
    const other = await setup();
    await send(other, other.a, { body: "secret" });
    await send(s, s.a, { body: "mine" });
    expect((await list(s, s.a)).messages.map((m) => m.body)).toEqual(["mine"]);
  });

  it("keeps order for messages created in the same instant (id breaks the tie)", async () => {
    const s = await setup();
    for (const id of ["msg_c", "msg_a", "msg_b"]) {
      await pool.query(
        `INSERT INTO messages (id, room_id, author_id, body, created_at) VALUES ($1, $2, $3, $1, '2033-03-03T00:00:00Z')`,
        [id, s.room, s.a.participant_id],
      );
    }
    expect((await list(s, s.a)).messages.map((m) => m.id)).toEqual(["msg_a", "msg_b", "msg_c"]);
    expect((await list(s, s.a, { after: "msg_a" })).messages.map((m) => m.id)).toEqual([
      "msg_b",
      "msg_c",
    ]);
    expect((await list(s, s.a, { before: "msg_c" })).messages.map((m) => m.id)).toEqual([
      "msg_a",
      "msg_b",
    ]);
  });
});

describe("secret scanning on messages (T902)", () => {
  // A real private-key block (high confidence) and a high-entropy assignment
  // (low confidence). Neither value may ever appear in an error, event, or
  // inbox summary — only the rule, position and fingerprint.
  const PRIVATE_KEY = [
    "-----BEGIN PRIVATE KEY-----",
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
    "-----END PRIVATE KEY-----",
  ].join("\n");
  const LOW_ENTROPY = "api_key = aB3dE5gH7jK9mN1pQ3rS5tU7vW9xY2zA";

  it("messages.send rejects a private-key block with secret_detected; the value is in no error, event, inbox or row", async () => {
    const s = await setup();
    const err = await rejects(send(s, s.a, { body: PRIVATE_KEY }), "VALIDATION");
    expect(err.details).toMatchObject({ reason: "secret_detected" });
    const findings = (err.details as { findings: Array<Record<string, unknown>> }).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "private_key_block",
      confidence: "high",
      location: { kind: "message", field: "body" },
    });
    // The matched value appears nowhere: not in the error, not in any event,
    // not in any inbox summary, and no message row was written.
    const serialized = JSON.stringify({ err, findings });
    expect(serialized).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7");
    const { rows: msgs } = await pool.query("SELECT * FROM messages WHERE room_id = $1", [s.room]);
    expect(msgs).toHaveLength(0);
    const { rows: inbox } = await pool.query("SELECT summary FROM inbox_items WHERE room_id = $1", [
      s.room,
    ]);
    for (const r of inbox)
      expect(r.summary).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7");
  });

  it("messages.send flags a low-confidence match: SECRET_SCAN to author and owner, location only in the summary", async () => {
    const s = await setup();
    // The room owner must be a real participant for the inbox FK; use s.b (not
    // the author s.a) so the author and owner are two distinct recipients.
    await pool.query("UPDATE rooms SET owner_id = $2 WHERE id = $1", [s.room, s.b.participant_id]);
    const out = await send(s, s.a, { body: LOW_ENTROPY });
    const m = out.response as MessageView;
    expect(m.body).toBe(LOW_ENTROPY); // flagged, not rejected
    const { rows } = await pool.query(
      `SELECT participant_id, summary FROM inbox_items
       WHERE room_id = $1 AND kind = 'SECRET_SCAN' ORDER BY participant_id`,
      [s.room],
    );
    // The author (s.a) and the room owner (s.b) each get one item.
    expect(rows.map((r) => r.participant_id).sort()).toEqual(
      [s.a.participant_id, s.b.participant_id].sort(),
    );
    const notifications = out.events.filter((event) => event.type === "inbox.delivered");
    expect(notifications.map((event) => event.payload["recipient_id"]).sort()).toEqual(
      [s.a.participant_id, s.b.participant_id].sort(),
    );
    expect(notifications.every((event) => event.payload["kind"] === "SECRET_SCAN")).toBe(true);
    for (const r of rows) {
      expect(r.summary).toContain(`message ${m.id}`);
      expect(r.summary).toContain("line 1");
      expect(r.summary).toContain("high_entropy_assignment");
      expect(r.summary).not.toContain("aB3dE5gH7jK9mN1pQ3rS5tU7vW9xY2zA");
    }
  });

  it("a body at the 32 KiB limit with the key on its last lines is still caught", async () => {
    const s = await setup();
    const filler = "Status update, nothing secret here.\n";
    const room = MAX_BODY_BYTES - Buffer.byteLength(PRIVATE_KEY);
    const head = filler.repeat(Math.floor(room / filler.length));
    const body = head + "x".repeat(room - head.length) + PRIVATE_KEY;
    expect(Buffer.byteLength(body)).toBe(MAX_BODY_BYTES);
    const err = await rejects(send(s, s.a, { body }), "VALIDATION");
    const findings = (err.details as { findings: Array<Record<string, unknown>> }).findings;
    expect(findings).toEqual([
      expect.objectContaining({
        rule: "private_key_block",
        line: body.split("\n").length - 2,
      }),
    ]);
  });

  it("editing a message that still has the same low-confidence match doesn't flag it again until the first flag is acknowledged", async () => {
    const s = await setup();
    await pool.query("UPDATE rooms SET owner_id = $2 WHERE id = $1", [s.room, s.b.participant_id]);
    const m = (await send(s, s.a, { body: LOW_ENTROPY })).response as MessageView;
    const flags = async () =>
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM inbox_items WHERE room_id = $1 AND kind = 'SECRET_SCAN'",
          [s.room],
        )
      ).rows[0].n as number;
    expect(await flags()).toBe(2); // author and owner

    // A typo fix elsewhere in the body: the same match on the same line, so nothing new.
    await s.d.dispatch(
      s.a,
      cmd("messages.edit", { message_id: m.id, body: `${LOW_ENTROPY} # staging` }),
    );
    expect(await flags()).toBe(2);

    // Once both have acknowledged the flag, a later edit that still has it raises it again.
    await pool.query("UPDATE inbox_items SET acked_at = clock_timestamp() WHERE room_id = $1", [
      s.room,
    ]);
    await s.d.dispatch(
      s.a,
      cmd("messages.edit", { message_id: m.id, body: `${LOW_ENTROPY} # prod` }),
    );
    expect(await flags()).toBe(4);
  });

  it("messages.edit rejects a new body that gains a private-key block", async () => {
    const s = await setup();
    const m = (await send(s, s.a, { body: "before" })).response as MessageView;
    const err = await rejects(
      s.d.dispatch(s.a, cmd("messages.edit", { message_id: m.id, body: `now: ${PRIVATE_KEY}` })),
      "VALIDATION",
    );
    expect(err.details).toMatchObject({ reason: "secret_detected" });
    const { rows } = await pool.query("SELECT body FROM messages WHERE id = $1", [m.id]);
    expect(rows[0].body).toBe("before"); // unchanged
  });
});
