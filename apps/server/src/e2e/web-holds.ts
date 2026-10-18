import type { Page, Route } from "playwright-core";
import { expect } from "vitest";

/**
 * Hold the response of every budget status read the page makes, until it is released: the server
 * answers at once, and the page is handed the answer on `release()`. Each read records the message
 * limit it saw for `agentId`, so a test can tell the read that saw a change from the ones that did not.
 */
export async function holdBudgetReads(page: Page, agentId: string) {
  type Read = {
    answered: boolean;
    sawLimit: number | undefined;
    release: () => void;
    delivered: Promise<void>;
  };
  const reads: Read[] = [];
  let holding = true;
  await page.route("**/v1/rooms/*/commands", async (route: Route) => {
    const request = route.request();
    const isRead =
      request.method() === "POST" && /"method"\s*:\s*"budgets\.get"/.test(request.postData() ?? "");
    if (!holding || !isRead) return route.continue();
    let release!: () => void;
    let delivered!: () => void;
    const read: Read = {
      answered: false,
      sawLimit: undefined,
      release: () => release(),
      delivered: new Promise<void>((resolve) => (delivered = resolve)),
    };
    const released = new Promise<void>((resolve) => (release = resolve));
    reads.push(read);
    const response = await route.fetch();
    const status = (await response.json()) as {
      response?: { agents?: { participant_id: string; effective?: { messages?: number } }[] };
    };
    read.sawLimit = status.response?.agents?.find((agent) => agent.participant_id === agentId)
      ?.effective?.messages;
    read.answered = true;
    await released;
    await route.fulfill({ response });
    delivered();
  });
  return {
    reads,
    /**
     * The newest read, by the order the page started them: the last one, once every read started so
     * far has been answered (and the page has had a moment to start any it was about to).
     */
    newest: async () => {
      await expect.poll(() => reads.length > 0 && reads.every((read) => read.answered)).toBe(true);
      await new Promise((done) => setTimeout(done, 250));
      await expect.poll(() => reads.every((read) => read.answered)).toBe(true);
      return reads[reads.length - 1]!;
    },
    /** The first read that saw this limit. */
    readSeeing: async (limit: number) => {
      await expect.poll(() => reads.some((read) => read.sawLimit === limit)).toBe(true);
      return reads.find((read) => read.sawLimit === limit)!;
    },
    /** Release every read still held, deliver them, and stop holding. */
    finish: async () => {
      holding = false;
      for (const read of reads) read.release();
      await Promise.all(reads.map((read) => read.delivered));
      await page.unroute("**/v1/rooms/*/commands");
    },
  };
}

/**
 * Hold the response of every command the page sends that `match` accepts: the server handles it at
 * once, and the page receives the response when `release()` is called. `answered` resolves when the
 * server has answered, `delivered` when the page has been handed the response. Requests that don't
 * match fall through to other route handlers.
 */
export async function holdCommands(
  page: Page,
  match: (method: string, params: Record<string, unknown>) => boolean,
) {
  type Held = {
    method: string;
    answered: boolean;
    release: () => void;
    /** Hand the page a server error instead of the held response. */
    fail: () => void;
    delivered: Promise<void>;
  };
  const held: Held[] = [];
  let holding = true;
  const handler = async (route: Route) => {
    const request = route.request();
    let envelope: { method?: string; params?: Record<string, unknown> } = {};
    try {
      envelope = JSON.parse(request.postData() ?? "{}");
    } catch {
      // not a command
    }
    if (
      !holding ||
      request.method() !== "POST" ||
      !envelope.method ||
      !match(envelope.method, envelope.params ?? {})
    )
      return route.fallback();
    let release!: (fail: boolean) => void;
    let delivered!: () => void;
    const entry: Held = {
      method: envelope.method,
      answered: false,
      release: () => release(false),
      fail: () => release(true),
      delivered: new Promise<void>((resolve) => (delivered = resolve)),
    };
    const released = new Promise<boolean>((resolve) => (release = resolve));
    held.push(entry);
    const response = await route.fetch();
    entry.answered = true;
    const failed = await released;
    if (failed)
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "INTERNAL", message: "The server failed" } }),
      });
    else await route.fulfill({ response });
    delivered();
  };
  await page.route("**/v1/rooms/*/commands", handler);
  return {
    held,
    /** The held commands with this method, once at least one has been answered by the server. */
    answered: async (method: string) => {
      await expect.poll(() => held.some((h) => h.method === method && h.answered)).toBe(true);
      // Give the page a moment to start any further matching reads it was about to make.
      await new Promise((done) => setTimeout(done, 250));
      return held.filter((h) => h.method === method);
    },
    /** Release everything still held, deliver it, and stop holding. */
    finish: async () => {
      holding = false;
      for (const h of held) h.release();
      await Promise.all(held.map((h) => h.delivered));
      await page.unroute("**/v1/rooms/*/commands", handler);
    },
  };
}

/** Let the page apply what it has just been handed. */
export const settle = (page: Page) =>
  page.evaluate(() => new Promise<void>((done) => setTimeout(done, 250)));
