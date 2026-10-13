import type { Page } from "playwright-core";
import { expect, it } from "vitest";
import type { WebFixture } from "./web-fixture.js";

export function registerWebAuthTests(fixture: WebFixture): void {
  it("T1503: signs in through the stub OAuth provider and logout closes the room stream", async () => {
    const page: Page = await fixture.browser!.newPage();
    const sockets: { close: boolean; greeted: boolean; frames: number }[] = [];
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    page.on("websocket", (socket) => {
      const opened = { close: false, greeted: false, frames: 0 };
      sockets.push(opened);
      socket.on("framereceived", (frame) => {
        opened.frames++;
        if (String(frame.payload).includes("hello_ok")) opened.greeted = true;
      });
      socket.on("close", () => {
        opened.close = true;
        resolveClosed();
      });
    });

    try {
      await page.goto(fixture.baseUrl);
      await page.getByTestId("oauth-stub").click();
      await page.getByRole("heading", { name: "Rooms" }).waitFor();
      expect(new URL(page.url()).search).toBe("");
      const storage = await page.evaluate(() => ({
        local: Object.keys(localStorage),
        session: Object.keys(sessionStorage),
      }));
      expect(storage).toEqual({ local: [], session: [] });
      expect(
        (await page.context().cookies()).some(
          (cookie) => cookie.name === "crossover_session" && cookie.httpOnly,
        ),
      ).toBe(true);

      const websocket = page.waitForEvent("websocket");
      await page.getByTestId("room-name").fill("Cookie session room");
      await page.getByTestId("room-objective").fill("Verify browser session logout");
      await page.getByTestId("room-create").click();
      await page.getByTestId("room-title").waitFor();
      await websocket;
      await expect.poll(() => sockets[0]?.greeted).toBe(true);
      await page.getByTestId("sign-out").click();
      await page.getByTestId("oauth-stub").waitFor();
      await closed;
      expect(sockets).toHaveLength(1);
      expect(sockets[0]?.close).toBe(true);
      const finalFrameCount = sockets[0]?.frames;
      await page.waitForTimeout(300);
      expect(sockets).toHaveLength(1);
      expect(sockets[0]?.frames).toBe(finalFrameCount);
      expect(
        (await page.context().cookies()).some((cookie) => cookie.name === "crossover_session"),
      ).toBe(false);
      expect(new URL(page.url()).search).toBe("");
      expect(
        await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]),
      ).toEqual([[], []]);
    } finally {
      await page.close();
    }
  });
}
