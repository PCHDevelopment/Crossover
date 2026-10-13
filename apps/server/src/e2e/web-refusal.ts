import type { Page } from "playwright-core";
import { expect } from "vitest";

/** Refuse the next matching browser command so its visible error path is covered. */
export async function refuseNextCommand(page: Page, method: string): Promise<() => Promise<void>> {
  let refused = false;
  const url = "**/v1/rooms/*/commands";
  await page.route(url, async (route) => {
    let requestMethod: unknown;
    try {
      requestMethod = (route.request().postDataJSON() as { method?: unknown }).method;
    } catch {
      // The browser can issue non-command POSTs to this route pattern in other flows.
    }
    if (refused || requestMethod !== method) {
      await route.continue();
      return;
    }
    refused = true;
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "FORBIDDEN", message: "The server refused this action" },
      }),
    });
  });
  return async () => {
    await page.unroute(url);
    expect(refused, `expected the browser to call ${method}`).toBe(true);
  };
}
