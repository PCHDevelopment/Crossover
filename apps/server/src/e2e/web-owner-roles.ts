import { CrossoverClient } from "@crossover/sdk";
import { manifest, type WebFixture } from "./web-fixture.js";
import type { Page } from "playwright-core";
import { expect, it } from "vitest";

export function registerWebOwnerRoleChanges(fixture: WebFixture): void {
  it("lets the owner change their own role in Owner controls after appointing a new lead", async () => {
    const page: Page = await fixture.browser!.newPage();
    const confirmations: string[] = [];
    page.on("dialog", (dialog) => {
      confirmations.push(dialog.message());
      void dialog.accept();
    });

    await page.goto(fixture.baseUrl);
    await page.getByTestId("login-name").fill("RoleOwner");
    await page.getByTestId("login-submit").click();
    await page.getByTestId("room-name").fill("Owner role controls");
    await page.getByTestId("room-objective").fill("Change a participant role from the browser");
    await page.getByTestId("room-create").click();
    await page.getByTestId("room-title").waitFor();
    const roomId = /\/rooms\/([^/]+)/.exec(new URL(page.url()).pathname)![1]!;

    const client = new CrossoverClient({ baseUrl: fixture.baseUrl });
    const login = await client.devLogin({ subject: "RoleOwner", display_name: "RoleOwner" });
    const ownerSession = await client.roomSession(login.session_token, roomId);
    const owner = client.room(roomId, ownerSession.tokens.access_token);
    const invite = await owner.api.room.invite<unknown>({ role: "DEVELOPER" });
    const joined = await client.join(roomId, {
      token: (invite.one_time as { token: string }).token,
      manifest: manifest("RoleAgent"),
    });
    const agentId = (joined as unknown as { participant_id: string }).participant_id;

    await page.getByTestId("tab-setup").click();
    await page.getByTestId("lead-participant").selectOption(agentId);
    await page.getByTestId("appoint-lead").click();
    await expect
      .poll(() => page.getByTestId("lead-status").textContent())
      .toContain("now the lead");

    await page.getByTestId("tab-owner-controls").click();
    await page.getByTestId("role-participant").selectOption(ownerSession.participant_id);
    await page.getByTestId("participant-role-value").selectOption("REVIEWER");
    await page.getByTestId("change-participant-role").click();
    await expect
      .poll(() => page.getByTestId("owner-controls-notice").textContent())
      .toContain("complete");

    const participant = await fixture.db.pool.query<{ role: string; authority: string }>(
      "SELECT role, authority FROM participants WHERE id = $1",
      [ownerSession.participant_id],
    );
    expect(participant.rows[0]).toEqual({ role: "REVIEWER", authority: "OWNER" });
    expect(confirmations).toContain("Change your role from DEVELOPER to REVIEWER?");

    await page.getByTestId("tab-overview").click();
    const ownerRow = page.locator('[data-name="RoleOwner"]');
    await expect
      .poll(() => ownerRow.locator("td").nth(2).textContent())
      .toContain("REVIEWER / OWNER");
    await page.close();
  }, 120_000);
}
