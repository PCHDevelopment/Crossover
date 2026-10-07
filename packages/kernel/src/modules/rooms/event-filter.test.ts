import type { Pool } from "@crossover/db";
import type { RoomEvent } from "@crossover/protocol";
import { describe, expect, it } from "vitest";
import type { Principal } from "../../principal.js";
import { createEventMatcher, resolveFilter, typeMatches } from "./event-filter.js";

const me = "part_me";
const principal = (role: Principal["role"] = "DEVELOPER", kind: Principal["kind"] = "AGENT") =>
  ({ participant_id: me, room_id: "room_1", kind, role, authority: "MEMBER" }) as Principal;
const event = (type: string, payload: Record<string, unknown> = {}, actor = "part_other") =>
  ({ room_id: "room_1", sequence: 1, actor_id: actor, type, payload }) as unknown as RoomEvent;
/** A database that must not be asked (the cases below are decided from the event alone). */
const noDb = {
  query: async () => Promise.reject(new Error("asked the database")),
} as unknown as Pool;

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
  const match = createEventMatcher(noDb, principal(), { profile: "relevant" });
  it("delivers room and lead changes, lead decisions, mentions of me, and things that name me", async () => {
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
      expect(await match(e), e.type).toBe(true);
    }
  });
  it("drops what is about others: chatter, other people's denials and participants", async () => {
    for (const e of [
      event("message.sent", { message: { mentions: ["x"] } }),
      event("capability.denied", {}, "part_other"),
      event("participant.paused", { participant_id: "part_other" }),
      event("decision.proposed", { decision: { id: "d" } }),
      event("sandbox.created", { participant_id: "part_other" }),
      event("workspace.health", { status: "GREEN" }),
    ]) {
      expect(await match(e), e.type).toBe(false);
    }
  });
});

describe("custom profile", () => {
  it("delivers matching types, plus mentions when asked, whatever the types say", async () => {
    const match = createEventMatcher(noDb, principal(), {
      profile: "custom",
      types: ["decision.*"],
      scopes: { mentions: true },
    });
    expect(await match(event("decision.proposed"))).toBe(true);
    expect(await match(event("task.created"))).toBe(false);
    expect(await match(event("message.sent", { message: { mentions: [me] } }))).toBe(true);
    expect(await match(event("message.sent", { message: { mentions: [] } }))).toBe(false);
  });
  it("tasks: all delivers every task event of the types; mine narrows them to mine", async () => {
    const all = createEventMatcher(noDb, principal(), {
      profile: "custom",
      types: ["task.*"],
      scopes: { tasks: "all" },
    });
    expect(await all(event("task.created", { task: { owner_id: "other" } }))).toBe(true);
    const mine = createEventMatcher(noDb, principal(), {
      profile: "custom",
      types: ["task.*"],
      scopes: { tasks: "mine" },
    });
    expect(await mine(event("task.created", { task: { owner_id: me } }))).toBe(true);
  });
  it("delivers when the database can't be asked: a filter drops noise, never information", async () => {
    const match = createEventMatcher(noDb, principal(), { profile: "relevant" });
    expect(await match(event("task.started", { task_id: "t" }))).toBe(true);
  });
});
