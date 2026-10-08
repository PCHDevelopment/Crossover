import type { RoomEvent } from "@crossover/protocol";
import { describe, expect, it } from "vitest";
import type { Principal } from "../../principal.js";
import { createEventMatcher, resolveFilter, typeMatches } from "./event-filter.js";

const me = "part_me";
const principal = (role: Principal["role"] = "DEVELOPER", kind: Principal["kind"] = "AGENT") =>
  ({ participant_id: me, room_id: "room_1", kind, role, authority: "MEMBER" }) as Principal;
const event = (type: string, payload: Record<string, unknown> = {}, actor = "part_other") =>
  ({ room_id: "room_1", sequence: 1, actor_id: actor, type, payload }) as unknown as RoomEvent;

describe("resolveFilter", () => {
  it("defaults to relevant for an agent and all for a human; types or scopes mean custom", () => {
    expect(resolveFilter("AGENT", {})).toEqual({ profile: "relevant" });
    expect(resolveFilter("HUMAN", {})).toEqual({ profile: "all" });
    expect(resolveFilter("AGENT", { types: ["task.*"] })).toEqual({
      profile: "custom",
      types: ["task.*"],
    });
    expect(resolveFilter("AGENT", { profile: "all" })).toEqual({ profile: "all" });
  });
  it("refuses types or scopes on a profile that doesn't take them", () => {
    expect(() => resolveFilter("AGENT", { profile: "relevant", types: ["task.*"] })).toThrow();
    expect(() => resolveFilter("AGENT", { profile: "all", scopes: { tasks: "mine" } })).toThrow();
  });
});

describe("typeMatches: pathological patterns", () => {
  it("is linear: a pattern of many stars against a long name is answered at once", () => {
    const stars = "*".repeat(40) + "x";
    const name = `workspace.changeset.${"a".repeat(2000)}`;
    const started = performance.now();
    expect(typeMatches(`workspace.changeset.${stars}`, name)).toBe(false);
    expect(typeMatches(`workspace.${"*a".repeat(30)}b.*`, `workspace.${"a".repeat(500)}.x`)).toBe(
      false,
    );
    expect(performance.now() - started).toBeLessThan(250);
  });
  it("matches by segment: * inside a name, never across dots", () => {
    expect(typeMatches("task.cre*", "task.created")).toBe(true);
    expect(typeMatches("*.created", "task.created")).toBe(true);
    expect(typeMatches("**.created", "task.created")).toBe(true);
    expect(typeMatches("task.*", "task.a.b")).toBe(false);
  });
});

describe("typeMatches", () => {
  it("a star stays inside one dotted name", () => {
    expect(typeMatches("task.*", "task.created")).toBe(true);
    expect(typeMatches("task.*", "task")).toBe(false);
    expect(typeMatches("task.*", "tasks.created")).toBe(false);
    expect(typeMatches("task.*", "workspace.conflict.created")).toBe(false);
    expect(typeMatches("workspace.conflict.*", "workspace.conflict.created")).toBe(true);
    expect(typeMatches("workspace.*", "workspace.conflict.created")).toBe(false);
    expect(typeMatches("message.sent", "message.sent")).toBe(true);
    expect(typeMatches("message.sent", "message.sent.x")).toBe(false);
    expect(typeMatches("a.b", "aXb")).toBe(false); // the dot is a dot
  });
});

describe("relevant profile (decided from the event)", () => {
  const match = createEventMatcher(principal(), { profile: "relevant" });
  it("delivers room and lead changes, lead decisions, mentions of me, and things that name me", () => {
    for (const e of [
      event("room.paused"),
      event("lead.changed", { from: "a", to: "b" }),
      event("decision.decided", { decision_id: "d" }),
      event("message.sent", { message: { mentions: ["x", me] } }),
      event("task.assigned", { participant_id: me, task_id: "t" }),
      event("participant.paused", { participant_id: me }),
      event("workspace.conflict.created", { submitter_id: me, changeset_id: "none" }),
      event("capability.denied", {}, me),
    ]) {
      expect(match(e), e.type).toBe(true);
    }
  });
  it("drops what is about others: chatter, other people's denials and participants", () => {
    for (const e of [
      event("message.sent", { message: { mentions: ["x"] } }),
      event("capability.denied", {}, "part_other"),
      event("participant.paused", { participant_id: "part_other" }),
      event("decision.proposed", { decision: { id: "d" } }),
      event("sandbox.created", { participant_id: "part_other" }),
      event("workspace.health", { status: "GREEN" }),
    ]) {
      expect(match(e), e.type).toBe(false);
    }
  });
});

describe("relevant profile: what travels with the event", () => {
  const match = createEventMatcher(principal(), { profile: "relevant" });
  it("a task event is about the owner it names (as of the event), a reviewer it names, and a new task nobody owns", () => {
    expect(match(event("task.started", { task_id: "t", owner_id: me }))).toBe(true);
    expect(match(event("task.started", { task_id: "t", owner_id: "part_b" }))).toBe(false);
    // The task changed hands later: this event is still B's, not mine.
    expect(match(event("task.updated", { task_id: "t", owner_id: "part_b" }))).toBe(false);
    expect(
      match(event("task.submitted", { task_id: "t", owner_id: "part_b", reviewer_id: me })),
    ).toBe(true);
    expect(
      match(event("task.lease_expired", { task_id: "t", owner_id: null, previous_owner_id: me })),
    ).toBe(true);
    expect(match(event("task.created", { task: { id: "t", owner_id: null } }))).toBe(true);
    expect(match(event("task.created", { task: { id: "t", owner_id: "part_b" } }))).toBe(false);
  });
  it("ChangeSet events name their author, and health RED names its suspects", () => {
    expect(match(event("workspace.changeset.applied", { changeset_id: "c", author_id: me }))).toBe(
      true,
    );
    expect(
      match(event("workspace.changeset.applied", { changeset_id: "c", author_id: "part_b" })),
    ).toBe(false);
    expect(
      match(event("workspace.conflict.resolved", { resolver_id: "part_l", submitter_id: me })),
    ).toBe(true);
    expect(match(event("workspace.health", { status: "RED", suspect_ids: ["x", me] }))).toBe(true);
    expect(match(event("workspace.health", { status: "RED", suspect_ids: ["x"] }))).toBe(false);
    expect(match(event("workspace.health", { status: "GREEN", suspect_ids: [me] }))).toBe(false);
  });
  it("an edited message that mentions me is relevant", () => {
    expect(match(event("message.edited", { message_id: "m", mentions: [me] }))).toBe(true);
    expect(match(event("message.edited", { message_id: "m", mentions: ["part_b"] }))).toBe(false);
  });
  it("an escalated conflict goes to whom it names", () => {
    expect(
      match(event("workspace.conflict.escalated", { conflict_id: "c", escalated_to: me })),
    ).toBe(true);
    expect(
      match(event("workspace.conflict.escalated", { conflict_id: "c", escalated_to: "part_l" })),
    ).toBe(false);
  });
  it("fails open: an event written before its type carried what the filter needs is delivered", () => {
    expect(match(event("task.started", { task_id: "t" }))).toBe(true); // no owner_id yet
    expect(match(event("workspace.changeset.applied", { changeset_id: "c" }))).toBe(true); // no author_id
    expect(match(event("workspace.health", { status: "RED" }))).toBe(true); // no suspect_ids
    expect(match(event("message.edited", { message_id: "m", body: "x" }))).toBe(true); // no mentions
    expect(
      match(event("workspace.conflict.resolved", { conflict_id: "c", resolver_id: "part_l" })),
    ).toBe(true); // no submitter_id
    // …but an event that does carry them is judged by them.
    expect(match(event("task.started", { task_id: "t", owner_id: null }))).toBe(false);
    expect(match(event("workspace.health", { status: "GREEN" }))).toBe(false);
    expect(
      match(
        event("workspace.conflict.resolved", { resolver_id: "part_l", submitter_id: "part_b" }),
      ),
    ).toBe(false);
  });
  it("never asks anything but the event: the same event gives the same answer whenever it is judged", () => {
    const e = event("task.started", { task_id: "t", owner_id: me });
    expect([
      match(e),
      match(e),
      createEventMatcher(principal(), { profile: "relevant" })(e),
    ]).toEqual([true, true, true]);
  });
});

describe("custom profile", () => {
  it("delivers matching types, plus mentions when asked, whatever the types say", () => {
    const match = createEventMatcher(principal(), {
      profile: "custom",
      types: ["decision.*"],
      scopes: { mentions: true },
    });
    expect(match(event("decision.proposed"))).toBe(true);
    expect(match(event("task.created"))).toBe(false);
    expect(match(event("message.sent", { message: { mentions: [me] } }))).toBe(true);
    expect(match(event("message.sent", { message: { mentions: [] } }))).toBe(false);
  });
  it("tasks: all delivers every task event of the types; mine narrows them to mine", () => {
    const all = createEventMatcher(principal(), {
      profile: "custom",
      types: ["task.*"],
      scopes: { tasks: "all" },
    });
    expect(all(event("task.created", { task: { owner_id: "other" } }))).toBe(true);
    const mine = createEventMatcher(principal(), {
      profile: "custom",
      types: ["task.*"],
      scopes: { tasks: "mine" },
    });
    expect(mine(event("task.created", { task: { owner_id: me } }))).toBe(true);
  });
});
