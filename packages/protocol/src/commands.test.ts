import { describe, expect, it } from "vitest";
import {
  commandEnvelopeSchema,
  isMethodName,
  isMutatingMethod,
  METHOD_NAMES,
  METHOD_PATTERN,
  METHODS,
} from "./commands.js";
import { newId } from "./ids.js";

// Copied from docs/ARCHITECTURE.md §16.1. Update both together.
const CATALOG = `
  room.get_state
  room.digest
  room.events.subscribe
  room.events.list
  room.set_egress_allowlist
  events.redact
  room.set_lead
  room.transfer_lead / room.accept_lead
  room.freeze / room.resume / room.archive
  room.invite

  participants.list / participants.get
  participants.set_role
  participants.update_manifest
  participants.wake_secret
  participants.pause / participants.resume / participants.remove
  presence.update
  presence.set_intent
  presence.clear_intent / presence.list_intents

  capabilities.list
  capabilities.grant / capabilities.revoke
  approvals.list / approvals.decide / approvals.withdraw

  messages.list
  messages.send
  messages.edit

  inbox.list
  inbox.ack

  tasks.list / tasks.get
  tasks.create / tasks.update
  tasks.claim / tasks.assign / tasks.release
  tasks.start / tasks.block / tasks.unblock
  tasks.submit / tasks.review / tasks.reopen / tasks.cancel
  tasks.heartbeat

  workspace.list / workspace.read / workspace.search
  workspace.diff / workspace.history / workspace.blame
  workspace.apply_changeset
  workspace.changeset.get
  workspace.health.get

  conflicts.list / conflicts.get
  conflicts.escalate / conflicts.abandon

  sandbox.status / sandbox.exec / sandbox.exec.cancel
  sandbox.sync / sandbox.reset
  changes.submit / changes.diff

  memory.list / memory.get / memory.history
  memory.put
  memory.delete

  decisions.list / decisions.get
  decisions.propose / decisions.add_position
  decisions.decide / decisions.withdraw / decisions.veto

  tools.list / tools.invoke

  integrations.connect / integrations.disconnect / integrations.verify / integrations.list

  git.import / git.pull_upstream
  checkpoints.create / checkpoints.list / checkpoints.export
`;
// `room.create` (T202) isn't in the §16.1 list: there is no room yet to scope it to.
const catalog = [...CATALOG.split(/[\s/]+/).filter(Boolean), "room.create"];

// The read-only methods, spelled out so changing the classification shows up in review.
const READ_ONLY = [
  "room.get_state",
  "room.digest",
  "room.events.subscribe",
  "room.events.list",
  "participants.list",
  "participants.get",
  "participants.wake_secret",
  "presence.update",
  "presence.set_intent",
  "presence.clear_intent",
  "presence.list_intents",
  "capabilities.list",
  "approvals.list",
  "messages.list",
  "inbox.list",
  "tasks.list",
  "tasks.get",
  "tasks.heartbeat",
  "workspace.list",
  "workspace.read",
  "workspace.search",
  "workspace.diff",
  "workspace.history",
  "workspace.blame",
  "workspace.changeset.get",
  "workspace.health.get",
  "conflicts.list",
  "conflicts.get",
  "sandbox.status",
  "changes.diff",
  "memory.list",
  "memory.get",
  "memory.history",
  "decisions.list",
  "decisions.get",
  "tools.list",
  "integrations.list",
  "checkpoints.list",
];

const withoutKey = (extra: Record<string, unknown> = {}): Record<string, unknown> => {
  const cmd: Record<string, unknown> = valid(extra);
  delete cmd["idempotency_key"];
  return cmd;
};

const valid = (extra: Record<string, unknown> = {}) => ({
  id: newId("cmd"),
  method: "tasks.claim",
  params: { task_id: "task_12", expected_version: 3 },
  idempotency_key: "agentA-7f3c",
  ...extra,
});

describe("METHODS", () => {
  it("contains every §16.1 method plus room.create, and nothing else", () => {
    expect(catalog).toHaveLength(95);
    expect([...METHOD_NAMES].sort()).toEqual([...catalog].sort());
  });

  it("every method matches the resource.action pattern", () => {
    for (const m of METHOD_NAMES) expect(METHOD_PATTERN.test(m), m).toBe(true);
  });

  it("marks exactly the documented methods read-only", () => {
    const readOnly = METHOD_NAMES.filter((m) => !isMutatingMethod(m));
    expect([...readOnly].sort()).toEqual([...READ_ONLY].sort());
    expect(Object.keys(METHODS).length - readOnly.length).toBe(57);
  });

  it("isMutatingMethod takes any string and is false for unknown methods", () => {
    expect(isMutatingMethod("tasks.claim")).toBe(true);
    expect(isMutatingMethod("tasks.list")).toBe(false);
    for (const unknown of ["tasks.exploded", "toString", "__proto__", ""]) {
      expect(isMutatingMethod(unknown), unknown).toBe(false);
    }
  });

  it("isMethodName only accepts own, known methods", () => {
    expect(isMethodName("tasks.claim")).toBe(true);
    expect(isMethodName("tasks.exploded")).toBe(false);
    expect(isMethodName("toString")).toBe(false);
    expect(isMethodName("__proto__")).toBe(false);
  });
});

describe("commandEnvelopeSchema", () => {
  it("accepts the §16.2 example shape", () => {
    const cmd = valid();
    expect(commandEnvelopeSchema.parse(cmd)).toEqual(cmd);
  });

  it("rejects a missing idempotency_key when the method is mutating", () => {
    const result = commandEnvelopeSchema.safeParse(withoutKey());
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ["idempotency_key"],
      message: expect.stringContaining("tasks.claim") as unknown,
    });
  });

  it("requires a key for every mutating method", () => {
    for (const method of METHOD_NAMES.filter((m) => isMutatingMethod(m))) {
      expect(commandEnvelopeSchema.safeParse(withoutKey({ method })).success, method).toBe(false);
      expect(commandEnvelopeSchema.safeParse(valid({ method })).success, method).toBe(true);
    }
  });

  it("doesn't require a key for read-only methods, but accepts one", () => {
    for (const method of READ_ONLY) {
      expect(commandEnvelopeSchema.safeParse(withoutKey({ method })).success, method).toBe(true);
      expect(commandEnvelopeSchema.safeParse(valid({ method })).success, method).toBe(true);
    }
  });

  it("validates idempotency_key length: 1 to 128 characters", () => {
    for (const ok of ["k", "k".repeat(128)]) {
      expect(commandEnvelopeSchema.safeParse(valid({ idempotency_key: ok })).success).toBe(true);
    }
    for (const bad of ["", "k".repeat(129), 5, null]) {
      expect(commandEnvelopeSchema.safeParse(valid({ idempotency_key: bad })).success).toBe(false);
    }
    // Still checked on a read-only method.
    expect(
      commandEnvelopeSchema.safeParse(valid({ method: "tasks.list", idempotency_key: "" })).success,
    ).toBe(false);
  });

  it("requires id to be a cmd_ ID", () => {
    for (const bad of [
      newId("task"),
      "cmd_",
      "cmd_123",
      "",
      42,
      undefined,
      "01J00000000000000000000000",
    ]) {
      expect(commandEnvelopeSchema.safeParse(valid({ id: bad })).success, String(bad)).toBe(false);
    }
  });

  it("requires method to look like resource.action", () => {
    for (const bad of [
      "tasks",
      "Tasks.claim",
      "tasks.",
      ".claim",
      "tasks..claim",
      "tasks.claim ",
      "tasks-claim",
      "",
      42,
    ]) {
      expect(commandEnvelopeSchema.safeParse(valid({ method: bad })).success, String(bad)).toBe(
        false,
      );
    }
  });

  it("parses an unknown method: the dispatcher answers NOT_FOUND, not the schema", () => {
    for (const method of ["tasks.exploded", "constructor.x", "a.b.c.d"]) {
      expect(commandEnvelopeSchema.safeParse(valid({ method })).success, method).toBe(true);
      // ...with or without a key: an unregistered method isn't "mutating"
      expect(commandEnvelopeSchema.safeParse(withoutKey({ method })).success, method).toBe(true);
    }
  });

  it("requires params to be an object", () => {
    expect(commandEnvelopeSchema.safeParse(valid({ params: {} })).success).toBe(true);
    for (const bad of [[], "x", 1, null, undefined]) {
      expect(commandEnvelopeSchema.safeParse(valid({ params: bad })).success, String(bad)).toBe(
        false,
      );
    }
  });

  it("rejects unknown fields (e.g. a camelCase idempotencyKey typo)", () => {
    expect(commandEnvelopeSchema.safeParse(valid({ idempotencyKey: "k" })).success).toBe(false);
    expect(commandEnvelopeSchema.safeParse(valid({ extra: 1 })).success).toBe(false);
  });

  it("rejects missing required fields", () => {
    for (const key of ["id", "method", "params"]) {
      const cmd: Record<string, unknown> = valid();
      delete cmd[key];
      expect(commandEnvelopeSchema.safeParse(cmd).success, key).toBe(false);
    }
  });
});
